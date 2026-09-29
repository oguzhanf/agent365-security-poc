'use strict';

// Engagement persistence for the PoC site. Each engagement (one tenant) is a
// JSON file in a data directory outside the source repository. Every change
// goes through a validated operation, runs under a per-engagement lock, and is
// written atomically. A daily backup copy protects against mistakes.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z?$/;
const GUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CHECKLIST_KEY = /^(setup|positive|negative|cleanup)\.\d{1,2}$/;
const MAX_ACTIVITY = 2000;
const MAX_BACKUPS = 30;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = message => { throw new HttpError(400, message); };
const nowIso = () => new Date().toISOString();

function localDate(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function validDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Field validators return the normalized value or throw a 400 error.
const V = {
  str: (max, { required = false } = {}) => (value, name) => {
    if (value === null || value === undefined) value = '';
    if (typeof value !== 'string') fail(`${name} must be text.`);
    const text = value.replace(/\u0000/g, '').replace(/\r\n/g, '\n');
    if (text.length > max) fail(`${name} is longer than ${max} characters.`);
    if (required && !text.trim()) fail(`${name} is required.`);
    return text;
  },
  oneOf: values => (value, name) => {
    if (!values.includes(value)) fail(`${name} must be one of: ${values.join(', ')}.`);
    return value;
  },
  bool: () => (value, name) => {
    if (typeof value !== 'boolean') fail(`${name} must be true or false.`);
    return value;
  },
  date: () => (value, name) => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value !== 'string' || !validDate(value)) fail(`${name} must be a date in YYYY-MM-DD form.`);
    return value;
  },
  datetime: () => (value, name) => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value !== 'string' || !DATETIME_PATTERN.test(value) || Number.isNaN(Date.parse(value.endsWith('Z') ? value : `${value}Z`))) {
      fail(`${name} must be a UTC date and time.`);
    }
    return value.endsWith('Z') ? value.slice(0, -1) : value;
  },
  pattern: (max, pattern, message) => (value, name) => {
    const text = V.str(max)(value, name).trim();
    if (text && !pattern.test(text)) fail(`${name}: ${message}`);
    return text;
  },
  number: ({ min = 0, max = 100000 } = {}) => (value, name) => {
    if (value === null || value === undefined || value === '') return null;
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number) || number < min || number > max) fail(`${name} must be a number from ${min} to ${max}.`);
    return Math.round(number * 10) / 10;
  }
};

const SETTINGS_SCHEMA = {
  name: V.str(120, { required: true }),
  customer: V.str(120),
  role: V.oneOf(['evaluation', 'demonstration']),
  tenant: {
    name: V.str(120),
    domain: V.pattern(253, /^[A-Za-z0-9.-]+$/, 'use a DNS domain name.'),
    tenant_id: V.pattern(36, GUID_PATTERN, 'use a tenant GUID.'),
    cloud: V.str(60),
    region: V.str(60)
  },
  start_date: V.date(),
  end_date: V.date(),
  calendar: V.oneOf(['calendar', 'working']),
  scopes: { live: V.bool(), optional: V.bool(), demo: V.bool() },
  prepared_by: V.str(160),
  approval_reference: V.str(200),
  evidence_location: V.str(500),
  owners: Object.fromEntries(['poc_lead', 'identity', 'microsoft_365', 'purview', 'defender', 'azure', 'endpoint', 'evidence_reviewer'].map(key => [key, V.str(160)])),
  test_bed: {
    users: V.str(500),
    devices: V.str(500),
    power_platform_environment: V.str(300),
    azure_subscription: V.str(300),
    resource_group: V.str(300),
    notes: V.str(4000)
  },
  budget: { currency: V.str(10), approved_limit: V.str(40) },
  report: {
    status: V.oneOf(['on_track', 'at_risk', 'off_track', 'complete']),
    status_comment: V.str(4000),
    key_messages: V.str(8000),
    executive_summary: V.str(20000),
    recommendations: V.str(20000),
    next_steps: V.str(8000)
  }
};

function mergeValidated(target, patch, schema, prefix) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(`${prefix || 'settings'} must be an object.`);
  for (const [key, value] of Object.entries(patch)) {
    const rule = schema[key];
    const name = prefix ? `${prefix}.${key}` : key;
    if (!rule) fail(`Unknown setting: ${name}.`);
    if (typeof rule === 'function') {
      target[key] = rule(value, name);
    } else {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      mergeValidated(target[key], value, rule, name);
    }
  }
  return target;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realOrResolved(target) {
  let current = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...suffix);
  } catch {
    return path.resolve(target);
  }
}

function defaultDataDir() {
  return process.env.A365_POC_SITE_DATA || path.join(os.homedir(), 'Agent365-PoC-Site');
}

class Store {
  constructor({ dataDir, repoRoot, model, compute }) {
    this.dataDir = path.resolve(dataDir || defaultDataDir());
    this.repoRoot = repoRoot;
    this.model = model;
    this.compute = compute;
    this.locks = new Map();
    this.stepById = new Map(model.steps.map(step => [step.id, step]));
    this.caseById = new Map(model.cases.map(item => [item.id, item]));
    this.metricIds = new Set(model.measurements.map(item => item.metric));
    this.templateInventory = new Set(model.inventory_template.map(item => item.id));
    this.inventoryStatuses = Object.keys(model.inventory_statuses);
    this.inventoryTypes = model.inventory_types.map(item => item.id);
  }

  get engagementsDir() { return path.join(this.dataDir, 'engagements'); }
  get trashDir() { return path.join(this.dataDir, 'trash'); }
  get backupDir() { return path.join(this.dataDir, 'backups'); }

  async init({ seedFiles = [] } = {}) {
    if (this.repoRoot && isInside(realOrResolved(this.dataDir), realOrResolved(this.repoRoot))) {
      throw new Error(`The data directory must be outside the source repository: ${this.dataDir}`);
    }
    for (const dir of [this.engagementsDir, this.trashDir, this.backupDir]) await fsp.mkdir(dir, { recursive: true });
    const marker = path.join(this.dataDir, '.seeded');
    const existing = await this.ids();
    if (!existing.length && !fs.existsSync(marker)) {
      const seedFile = seedFiles.find(file => file && fs.existsSync(file));
      if (seedFile) {
        const seed = JSON.parse(await fsp.readFile(seedFile, 'utf8'));
        for (const entry of seed.engagements || []) await this.createFromSeed(entry);
        this.seededFrom = seedFile;
      }
      await fsp.writeFile(marker, `${nowIso()}\n`, 'utf8');
    }
  }

  async ids() {
    const names = await fsp.readdir(this.engagementsDir).catch(() => []);
    return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(id => ID_PATTERN.test(id)).sort();
  }

  file(id) {
    if (!ID_PATTERN.test(String(id))) throw new HttpError(404, 'Engagement not found.');
    return path.join(this.engagementsDir, `${id}.json`);
  }

  async read(id) {
    const file = this.file(id);
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'Engagement not found.');
      throw error;
    }
    return JSON.parse(text);
  }

  async write(engagement) {
    const file = this.file(engagement.id);
    const stamp = localDate().replace(/-/g, '');
    const backup = path.join(this.backupDir, `${engagement.id}-${stamp}.json`);
    if (fs.existsSync(file) && !fs.existsSync(backup)) {
      await fsp.copyFile(file, backup);
      await this.pruneBackups(engagement.id);
    }
    const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(engagement, null, 2)}\n`, 'utf8');
    // Antivirus or indexing can hold a brief lock on Windows. Retry the atomic rename.
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(temp, file);
        return;
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
          await fsp.unlink(temp).catch(() => {});
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 60 * attempt));
      }
    }
  }

  async pruneBackups(id) {
    const names = (await fsp.readdir(this.backupDir)).filter(name => name.startsWith(`${id}-`) && /-\d{8}\.json$/.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) await fsp.unlink(path.join(this.backupDir, name));
  }

  async withLock(id, task) {
    const previous = this.locks.get(id) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chained = previous.then(() => gate);
    this.locks.set(id, chained);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(id) === chained) this.locks.delete(id);
    }
  }

  async list() {
    const result = [];
    for (const id of await this.ids()) {
      try {
        const engagement = await this.read(id);
        const settings = engagement.settings || {};
        result.push({
          id,
          name: settings.name,
          customer: settings.customer,
          role: settings.role,
          tenant: settings.tenant?.name || '',
          start_date: settings.start_date,
          updated_at: engagement.updated_at
        });
      } catch {
        result.push({ id, name: `${id} (unreadable)`, role: 'evaluation', error: true });
      }
    }
    return result;
  }

  async get(id) {
    return this.read(id);
  }

  async uniqueId(base) {
    const root = (String(base || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)) || 'engagement';
    const candidate = ID_PATTERN.test(root) ? root : `poc-${root}`.slice(0, 32);
    const ids = new Set(await this.ids());
    if (!ids.has(candidate)) return candidate;
    for (let index = 2; index < 1000; index++) {
      const next = `${candidate}-${index}`;
      if (!ids.has(next)) return next;
    }
    throw new HttpError(409, 'Too many engagements with this name.');
  }

  blank(id, role, settings) {
    const now = nowIso();
    const engagement = {
      schema_version: 1,
      id,
      created_at: now,
      updated_at: now,
      revision: 0,
      settings: {
        name: role === 'demonstration' ? 'Demonstration tenant' : 'Customer evaluation tenant',
        customer: '',
        role,
        tenant: { name: '', domain: '', tenant_id: '', cloud: 'Commercial', region: '' },
        start_date: '',
        end_date: '',
        calendar: 'calendar',
        scopes: this.compute.defaultScopes(role),
        prepared_by: '',
        approval_reference: '',
        evidence_location: '',
        owners: { poc_lead: '', identity: '', microsoft_365: '', purview: '', defender: '', azure: '', endpoint: '', evidence_reviewer: '' },
        test_bed: { users: 'u-allow, u-deny', devices: '', power_platform_environment: '', azure_subscription: '', resource_group: '', notes: '' },
        budget: { currency: '', approved_limit: '' },
        report: { status: 'on_track', status_comment: '', key_messages: '', executive_summary: '', recommendations: '', next_steps: '' }
      },
      steps: {},
      cases: {},
      notes: [],
      inventory: {},
      custom_inventory: [],
      measurements: {},
      history: {},
      activity: []
    };
    if (settings) {
      const { role: ignoredRole, ...rest } = settings;
      mergeValidated(engagement.settings, rest, SETTINGS_SCHEMA);
      if (rest.scopes === undefined) engagement.settings.scopes = this.compute.defaultScopes(role);
    }
    engagement.settings.scopes.live = true;
    return engagement;
  }

  async create({ id, preset, settings } = {}) {
    const role = preset === 'demonstration' || settings?.role === 'demonstration' ? 'demonstration' : 'evaluation';
    let engagementId;
    if (id !== undefined) {
      if (!ID_PATTERN.test(String(id))) fail('The engagement ID must use 2-40 lowercase letters, digits, or hyphens.');
      if ((await this.ids()).includes(id)) throw new HttpError(409, 'An engagement with this ID exists.');
      engagementId = id;
    } else {
      engagementId = await this.uniqueId(settings?.name || role);
    }
    const engagement = this.blank(engagementId, role, settings);
    this.log(engagement, 'engagement', engagementId, 'Engagement created.');
    this.snapshot(engagement);
    await this.write(engagement);
    return engagement;
  }

  async createFromSeed(entry) {
    const engagement = await this.create({ id: entry.id, preset: entry.preset, settings: entry.settings });
    return this.mutate(engagement.id, current => {
      for (const [itemId, patch] of Object.entries(entry.inventory || {})) this.opInventory(current, itemId, patch);
      for (const item of entry.custom_inventory || []) {
        const { status, actual_name: actualName, owner, note, ...definition } = item;
        const created = this.opAddInventory(current, definition);
        this.opInventory(current, created.id, { status: status || 'planned', actual_name: actualName || '', owner: owner || '', note: note || '' });
      }
      for (const note of entry.notes || []) this.opAddNote(current, note);
      for (const [caseId, patch] of Object.entries(entry.cases || {})) this.opCase(current, caseId, patch);
      this.log(current, 'engagement', current.id, 'Engagement seeded.');
    });
  }

  async remove(id) {
    return this.withLock(id, async () => {
      const file = this.file(id);
      if (!fs.existsSync(file)) throw new HttpError(404, 'Engagement not found.');
      const stamp = nowIso().replace(/[:.]/g, '-');
      await fsp.rename(file, path.join(this.trashDir, `${id}-${stamp}.json`));
      return { removed: id };
    });
  }

  log(engagement, kind, ref, text) {
    engagement.activity.push({ at: nowIso(), kind, ref, text: String(text).slice(0, 300) });
    if (engagement.activity.length > MAX_ACTIVITY) engagement.activity.splice(0, engagement.activity.length - MAX_ACTIVITY);
  }

  snapshot(engagement) {
    engagement.history[localDate()] = this.compute.snapshot(this.model, engagement);
    const keys = Object.keys(engagement.history).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - 400))) delete engagement.history[key];
  }

  async mutate(id, change) {
    return this.withLock(id, async () => {
      const engagement = await this.read(id);
      const result = await change(engagement);
      engagement.revision = (engagement.revision || 0) + 1;
      engagement.updated_at = nowIso();
      this.snapshot(engagement);
      await this.write(engagement);
      return result === undefined ? engagement : result;
    });
  }

  // Operations. Each validates its input and records one activity entry.

  opSettings(engagement, patch) {
    const next = JSON.parse(JSON.stringify(engagement.settings));
    mergeValidated(next, patch, SETTINGS_SCHEMA);
    next.scopes.live = true;
    engagement.settings = next;
    this.log(engagement, 'settings', engagement.id, `Settings updated: ${Object.keys(patch).join(', ')}.`);
  }

  opStep(engagement, stepId, patch) {
    const step = this.stepById.get(stepId);
    if (!step) throw new HttpError(404, `Unknown step: ${stepId}`);
    if (!patch || typeof patch !== 'object') fail('The step update must be an object.');
    const current = { ...(engagement.steps[stepId] || {}) };
    const before = current.status || 'todo';
    if (patch.status !== undefined) current.status = V.oneOf(this.compute.STEP_STATUSES)(patch.status, 'status');
    if (patch.note !== undefined) current.note = V.str(4000)(patch.note, 'note');
    const after = current.status || 'todo';
    current.updated_at = nowIso();
    current.hash = step.hash;
    if (after === 'done' && before !== 'done') current.done_at = current.updated_at;
    if (after !== 'done') delete current.done_at;
    if (after === 'todo' && !current.note) delete engagement.steps[stepId];
    else engagement.steps[stepId] = current;
    if (before !== after) this.log(engagement, 'step', stepId, `${stepId}: ${this.compute.STEP_LABELS[before]} to ${this.compute.STEP_LABELS[after]}.`);
    else this.log(engagement, 'step', stepId, `${stepId}: note updated.`);
  }

  opSteps(engagement, ids, status) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000) fail('Provide between 1 and 1000 step IDs.');
    const value = V.oneOf(this.compute.STEP_STATUSES)(status, 'status');
    let changed = 0;
    for (const stepId of ids) {
      const step = this.stepById.get(stepId);
      if (!step) throw new HttpError(404, `Unknown step: ${stepId}`);
      const current = { ...(engagement.steps[stepId] || {}) };
      const before = current.status || 'todo';
      if (before === value) continue;
      current.status = value;
      current.updated_at = nowIso();
      current.hash = step.hash;
      if (value === 'done') current.done_at = current.updated_at;
      else delete current.done_at;
      if (value === 'todo' && !current.note) delete engagement.steps[stepId];
      else engagement.steps[stepId] = current;
      changed += 1;
    }
    this.log(engagement, 'step', ids[0], `${changed} step(s) set to ${this.compute.STEP_LABELS[value]}.`);
    return changed;
  }

  opCase(engagement, caseId, patch) {
    const item = this.caseById.get(caseId);
    if (!item) throw new HttpError(404, `Unknown use case: ${caseId}`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('The use case update must be an object.');
    const record = JSON.parse(JSON.stringify(engagement.cases[caseId] || {}));
    const beforeResult = this.compute.caseResult(record);
    const beforeDemo = this.compute.demoStatus(record);
    const now = nowIso();
    const allowed = new Set(['phases', 'evidence_kind', 'agent', 'correlation_id', 'evidence_refs', 'checklist', 'customer_summary', 'internal_notes', 'demo', 'exclusion']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) fail(`Unknown use case field: ${key}.`);
    if (patch.phases !== undefined) {
      if (!patch.phases || typeof patch.phases !== 'object') fail('phases must be an object.');
      record.phases = record.phases || {};
      for (const [phase, value] of Object.entries(patch.phases)) {
        if (!this.compute.PHASES.includes(phase)) fail(`Unknown phase: ${phase}.`);
        if (!value || typeof value !== 'object') fail(`${phase} must be an object.`);
        const current = { ...(record.phases[phase] || {}) };
        if (value.result !== undefined) current.result = V.oneOf(this.compute.RESULTS)(value.result, `${phase}.result`);
        if (value.reason !== undefined) current.reason = V.str(2000)(value.reason, `${phase}.reason`);
        current.at = now;
        record.phases[phase] = current;
      }
    }
    if (patch.evidence_kind !== undefined) record.evidence_kind = V.oneOf(this.compute.EVIDENCE_KINDS)(patch.evidence_kind, 'evidence_kind');
    if (patch.agent !== undefined) record.agent = V.pattern(64, ALIAS_PATTERN, 'use letters, digits, dots, underscores, or hyphens.')(patch.agent, 'agent');
    if (patch.correlation_id !== undefined) record.correlation_id = V.str(128)(patch.correlation_id, 'correlation_id').trim();
    if (patch.evidence_refs !== undefined) {
      if (!Array.isArray(patch.evidence_refs) || patch.evidence_refs.length > 50) fail('evidence_refs must be a list of up to 50 entries.');
      record.evidence_refs = patch.evidence_refs.map((ref, index) => V.str(512)(ref, `evidence_refs[${index}]`).trim()).filter(Boolean);
    }
    if (patch.checklist !== undefined) {
      if (!patch.checklist || typeof patch.checklist !== 'object') fail('checklist must be an object.');
      record.checklist = record.checklist || {};
      for (const [key, value] of Object.entries(patch.checklist)) {
        if (!CHECKLIST_KEY.test(key)) fail(`Unknown checklist item: ${key}.`);
        if (V.bool()(value, key)) record.checklist[key] = true;
        else delete record.checklist[key];
      }
    }
    if (patch.customer_summary !== undefined) record.customer_summary = V.str(4000)(patch.customer_summary, 'customer_summary');
    if (patch.internal_notes !== undefined) record.internal_notes = V.str(20000)(patch.internal_notes, 'internal_notes');
    if (patch.demo !== undefined) {
      if (!patch.demo || typeof patch.demo !== 'object') fail('demo must be an object.');
      const demo = { ...(record.demo || {}) };
      const rules = {
        status: V.oneOf(this.compute.DEMO_STATUSES), date: V.date(), audience: V.str(300), environment: V.str(200),
        shown: V.str(4000), feedback: V.str(4000), follow_up: V.bool()
      };
      mergeValidated(demo, patch.demo, rules, 'demo');
      if (demo.status === 'DEMONSTRATED' && !demo.date) demo.date = localDate();
      record.demo = demo;
    }
    if (patch.exclusion !== undefined) {
      if (patch.exclusion === null) {
        delete record.exclusion;
      } else {
        if (item.scope !== 'live') fail('Only live-proofed use cases can be excluded from the agreed denominator.');
        const exclusion = patch.exclusion;
        if (!exclusion || typeof exclusion !== 'object') fail('exclusion must be an object or null.');
        record.exclusion = {
          reason: V.str(2000, { required: true })(exclusion.reason, 'exclusion.reason'),
          approved_by: V.pattern(64, ALIAS_PATTERN, 'use an approver alias.')(exclusion.approved_by, 'exclusion.approved_by'),
          approved_date: V.date()(exclusion.approved_date, 'exclusion.approved_date')
        };
        if (!record.exclusion.approved_by || !record.exclusion.approved_date) fail('An exclusion needs an approver alias and an approval date.');
      }
    }
    const afterResult = this.compute.caseResult(record);
    if (!record.started_at && this.compute.hasCaseActivity(record)) record.started_at = now;
    if (this.compute.FINAL_RESULTS.includes(afterResult) && afterResult !== beforeResult) record.completed_at = now;
    if (!this.compute.FINAL_RESULTS.includes(afterResult)) delete record.completed_at;
    record.updated_at = now;
    engagement.cases[caseId] = record;
    const afterDemo = this.compute.demoStatus(record);
    if (afterResult !== beforeResult) this.log(engagement, 'case', caseId, `${caseId}: ${this.compute.RESULT_LABELS[beforeResult]} to ${this.compute.RESULT_LABELS[afterResult]}.`);
    else if (afterDemo !== beforeDemo) this.log(engagement, 'case', caseId, `${caseId}: demonstration ${this.compute.DEMO_LABELS[afterDemo].toLowerCase()}.`);
    else this.log(engagement, 'case', caseId, `${caseId}: record updated.`);
  }

  noteFields(target, patch) {
    const rules = {
      date: V.date(), category: V.oneOf(this.compute.NOTE_CATEGORIES), title: V.str(200, { required: true }),
      body: V.str(20000), shareable: V.bool(), related: V.str(300), owner: V.str(160), due: V.date(), resolved: V.bool()
    };
    mergeValidated(target, patch, rules, 'note');
    return target;
  }

  opAddNote(engagement, patch) {
    const now = nowIso();
    const note = this.noteFields({
      id: `N-${crypto.randomBytes(5).toString('hex')}`,
      date: localDate(), category: 'general', title: '', body: '', shareable: false, related: '', owner: '', due: '', resolved: false
    }, patch || {});
    if (!note.title.trim()) fail('note.title is required.');
    note.created_at = now;
    note.updated_at = now;
    engagement.notes.push(note);
    this.log(engagement, 'note', note.id, `Note added: ${note.title}.`);
    return note;
  }

  opUpdateNote(engagement, noteId, patch) {
    const note = engagement.notes.find(item => item.id === noteId);
    if (!note) throw new HttpError(404, 'Note not found.');
    const next = this.noteFields({ ...note }, patch || {});
    next.updated_at = nowIso();
    Object.assign(note, next);
    this.log(engagement, 'note', noteId, `Note updated: ${note.title}.`);
    return note;
  }

  opDeleteNote(engagement, noteId) {
    const index = engagement.notes.findIndex(item => item.id === noteId);
    if (index < 0) throw new HttpError(404, 'Note not found.');
    const [note] = engagement.notes.splice(index, 1);
    this.log(engagement, 'note', noteId, `Note deleted: ${note.title}.`);
  }

  opInventory(engagement, itemId, patch) {
    const custom = engagement.custom_inventory.some(item => item.id === itemId);
    if (!this.templateInventory.has(itemId) && !custom) throw new HttpError(404, `Unknown tenant object: ${itemId}`);
    const record = { ...(engagement.inventory[itemId] || {}) };
    mergeValidated(record, patch || {}, {
      status: V.oneOf(this.inventoryStatuses), actual_name: V.str(300), owner: V.str(160), note: V.str(4000)
    }, 'inventory');
    record.updated_at = nowIso();
    engagement.inventory[itemId] = record;
    this.log(engagement, 'inventory', itemId, `${itemId}: ${this.model.inventory_statuses[record.status || 'planned']}.`);
  }

  opAddInventory(engagement, definition) {
    const item = { id: `CUS-${crypto.randomBytes(4).toString('hex')}`, custom: true, guides: [], cases: [] };
    mergeValidated(item, definition || {}, {
      type: V.oneOf(this.inventoryTypes), name: V.str(200, { required: true }), purpose: V.str(1000),
      scope: V.oneOf(['live', 'demo']), cleanup: V.str(1000)
    }, 'inventory');
    if (!item.type) fail('inventory.type is required.');
    item.scope = item.scope || 'live';
    engagement.custom_inventory.push(item);
    this.log(engagement, 'inventory', item.id, `Tenant object added: ${item.name}.`);
    return item;
  }

  opDeleteInventory(engagement, itemId) {
    const index = engagement.custom_inventory.findIndex(item => item.id === itemId);
    if (index < 0) throw new HttpError(404, 'Only added tenant objects can be deleted.');
    const [item] = engagement.custom_inventory.splice(index, 1);
    delete engagement.inventory[itemId];
    this.log(engagement, 'inventory', itemId, `Tenant object deleted: ${item.name}.`);
  }

  opMeasurement(engagement, metric, patch) {
    if (!this.metricIds.has(metric)) throw new HttpError(404, `Unknown measurement: ${metric}`);
    const record = { ...(engagement.measurements[metric] || {}) };
    mergeValidated(record, patch || {}, {
      target_minutes: V.number(), start_utc: V.datetime(), end_utc: V.datetime(), measured_minutes: V.number(),
      case: V.pattern(12, /^[A-Z][A-Z0-9]*-\d{2,3}$/, 'use a use case ID.'), evidence: V.str(1000), notes: V.str(2000)
    }, 'measurement');
    if (record.case && !this.caseById.has(record.case)) fail(`Unknown use case: ${record.case}.`);
    if (patch && patch.measured_minutes === undefined && record.start_utc && record.end_utc) {
      const minutes = (Date.parse(`${record.end_utc}Z`) - Date.parse(`${record.start_utc}Z`)) / 60000;
      if (minutes < 0) fail('The end time must follow the start time.');
      record.measured_minutes = Math.round(minutes * 10) / 10;
    }
    record.updated_at = nowIso();
    engagement.measurements[metric] = record;
    this.log(engagement, 'measurement', metric, `${metric} updated.`);
  }

  async importEngagement(data) {
    if (!data || typeof data !== 'object' || data.schema_version !== 1 || !data.settings || typeof data.settings !== 'object') {
      fail('The file is not an exported PoC engagement.');
    }
    const settings = JSON.parse(JSON.stringify(data.settings));
    const role = settings.role === 'demonstration' ? 'demonstration' : 'evaluation';
    delete settings.role;
    const engagement = await this.create({ preset: role, settings: { ...settings, name: settings.name || 'Imported engagement' } });
    let skipped = 0;
    await this.mutate(engagement.id, current => {
      for (const [stepId, record] of Object.entries(data.steps || {})) {
        if (!this.stepById.has(stepId)) { skipped += 1; continue; }
        this.opStep(current, stepId, { status: record.status || 'todo', note: record.note || '' });
        for (const key of ['updated_at', 'done_at']) {
          if (typeof record[key] === 'string' && !Number.isNaN(Date.parse(record[key])) && current.steps[stepId]) current.steps[stepId][key] = record[key];
        }
      }
      for (const [caseId, record] of Object.entries(data.cases || {})) {
        if (!this.caseById.has(caseId)) { skipped += 1; continue; }
        const patch = {};
        for (const key of ['phases', 'evidence_kind', 'agent', 'correlation_id', 'evidence_refs', 'checklist', 'customer_summary', 'internal_notes', 'demo', 'exclusion']) {
          if (record[key] !== undefined) patch[key] = record[key];
        }
        if (patch.phases) {
          patch.phases = Object.fromEntries(Object.entries(patch.phases).map(([phase, value]) => [phase, { result: value?.result, reason: value?.reason || '' }]));
        }
        this.opCase(current, caseId, patch);
        for (const key of ['started_at', 'completed_at']) {
          if (typeof record[key] === 'string' && !Number.isNaN(Date.parse(record[key]))) current.cases[caseId][key] = record[key];
        }
      }
      for (const note of data.notes || []) {
        const { id, created_at: createdAt, updated_at: updatedAt, ...fields } = note || {};
        this.opAddNote(current, fields);
      }
      for (const item of data.custom_inventory || []) {
        const created = this.opAddInventory(current, { type: item.type, name: item.name, purpose: item.purpose || '', scope: item.scope || 'live', cleanup: item.cleanup || '' });
        const record = data.inventory?.[item.id];
        if (record) this.opInventory(current, created.id, { status: record.status || 'planned', actual_name: record.actual_name || '', owner: record.owner || '', note: record.note || '' });
      }
      for (const [itemId, record] of Object.entries(data.inventory || {})) {
        if (!this.templateInventory.has(itemId)) continue;
        this.opInventory(current, itemId, { status: record.status || 'planned', actual_name: record.actual_name || '', owner: record.owner || '', note: record.note || '' });
      }
      for (const [metric, record] of Object.entries(data.measurements || {})) {
        if (!this.metricIds.has(metric)) { skipped += 1; continue; }
        const { updated_at: ignored, ...fields } = record || {};
        this.opMeasurement(current, metric, fields);
      }
      for (const [day, value] of Object.entries(data.history || {})) {
        if (validDate(day) && value && typeof value === 'object') {
          current.history[day] = Object.fromEntries(Object.entries(value).filter(([, number]) => Number.isFinite(number)));
        }
      }
      this.log(current, 'engagement', current.id, `Imported from an export. ${skipped} unknown item(s) skipped.`);
    });
    return { id: engagement.id, skipped };
  }
}

module.exports = { Store, HttpError, defaultDataDir, isInside, ID_PATTERN, SETTINGS_SCHEMA };
