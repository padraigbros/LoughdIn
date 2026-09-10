const QUADRANTS = ['do', 'schedule', 'delegate', 'eliminate'];
const QUADRANT_LABELS = {
  do: 'Do first',
  schedule: 'Schedule',
  delegate: 'Delegate',
  eliminate: 'Eliminate',
};
const QUADRANT_HINTS = {
  do: 'Urgent and important',
  schedule: 'Important, with time to plan',
  delegate: 'Urgent, but someone else can own it',
  eliminate: 'Neither urgent nor important',
};
const STYLE_ID = 'loughdin-planner-styles';
const MINUTE = 60 * 1000;

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date');
  return date;
}

function cloneDate(value) {
  return new Date(asDate(value).getTime());
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** Snap a minute value to the nearest five-minute grid, bounded to a day. */
export function snapMinutes(minutes, increment = 5) {
  if (!Number.isFinite(minutes)) throw new TypeError('Minutes must be finite');
  if (!Number.isInteger(increment) || increment <= 0) throw new TypeError('Increment must be positive');
  return Math.min(24 * 60, Math.max(0, Math.round(minutes / increment) * increment));
}

export function intervalsOverlap(first, second) {
  const firstStart = asDate(first.startAt).getTime();
  const firstEnd = asDate(first.endAt).getTime();
  const secondStart = asDate(second.startAt).getTime();
  const secondEnd = asDate(second.endAt).getTime();
  return firstStart < secondEnd && secondStart < firstEnd;
}

export function validateBlock(block, blocks = []) {
  if (!block || typeof block !== 'object') return { ok: false, error: 'Choose a time block.' };
  if (!block.taskId) return { ok: false, error: 'Choose a task for this block.' };
  let start;
  let end;
  try {
    start = asDate(block.startAt);
    end = asDate(block.endAt);
  } catch {
    return { ok: false, error: 'Enter a valid start and end time.' };
  }
  if (end.getTime() <= start.getTime()) return { ok: false, error: 'End time must be after start time.' };
  if ((end.getTime() - start.getTime()) / MINUTE < 5) {
    return { ok: false, error: 'Blocks must be at least five minutes.' };
  }
  if (blocks.some(existing => {
    if (existing.id === block.id || existing.deletedAt || existing.status === 'cancelled') return false;
    try { return intervalsOverlap(block, existing); } catch { return false; }
  })) {
    return { ok: false, error: 'That time overlaps another block.' };
  }
  return { ok: true, error: null };
}

export function localDateKey(value = new Date()) {
  const date = asDate(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dateFromKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) throw new TypeError('Invalid local date key');
  const [year, month, day] = String(key).split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new TypeError('Invalid local date key');
  }
  return date;
}

export function addLocalDays(value, days) {
  const date = cloneDate(value);
  date.setDate(date.getDate() + days);
  return date;
}

export function rangeForDate(value, range = 'day') {
  const date = dateFromKey(localDateKey(value));
  date.setHours(0,0,0,0);
  if (range === 'day') return { start: date, end: addLocalDays(date, 1) };
  if (range !== 'week') throw new TypeError(`Unknown planner range: ${range}`);
  const mondayOffset = (date.getDay() + 6) % 7;
  const start = addLocalDays(date, -mondayOffset);
  return { start, end: addLocalDays(start, 7) };
}

export function blocksForRange(blocks = [], rangeStart, rangeEnd) {
  const start = asDate(rangeStart).getTime();
  const end = asDate(rangeEnd).getTime();
  return blocks.filter(block => {
    if (block.deletedAt || block.status === 'cancelled') return false;
    try {
      return asDate(block.startAt).getTime() < end && asDate(block.endAt).getTime() > start;
    } catch {
      return false;
    }
  });
}

export function toLocalInputParts(value) {
  const date = asDate(value);
  return {
    date: localDateKey(date),
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

export function fromLocalInputs(dateValue, timeValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue)) || !/^\d{2}:\d{2}$/.test(String(timeValue))) {
    throw new TypeError('Enter a local date and time');
  }
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hours, minutes] = timeValue.split(':').map(Number);
  if (hours > 23 || minutes > 59) throw new TypeError('Invalid local time');
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (Number.isNaN(date.getTime()) || localDateKey(date) !== dateValue || date.getHours() !== hours || date.getMinutes() !== minutes) {
    throw new TypeError('Invalid local date');
  }
  return date;
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function allTasks(state) {
  const tasks = state?.tasks || {};
  return [...(Array.isArray(tasks.work) ? tasks.work : []), ...(Array.isArray(tasks.personal) ? tasks.personal : [])].filter(task => !task.deletedAt);
}

function taskList(state, list) {
  const tasks = state?.tasks?.[list];
  return Array.isArray(tasks) ? tasks.filter(task => !task.deletedAt) : [];
}

function text(element, value) {
  element.textContent = value == null ? '' : String(value);
  return element;
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) text(node, content);
  return node;
}

function button(label, className, action) {
  const node = el('button', className, label);
  node.type = 'button';
  if (action) node.addEventListener('click', action);
  return node;
}

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.ld-planner{color:var(--sage-ink,#23352d);background:var(--sage-surface,rgba(255,255,255,.78));border:1px solid rgba(51,75,61,.14);border-radius:18px;padding:clamp(14px,3vw,24px);margin-top:18px;box-shadow:0 12px 36px rgba(26,52,38,.08)}
.ld-planner[hidden]{display:none}.ld-planner__header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}.ld-planner__title{margin:0;font:600 clamp(18px,3vw,25px)/1.15 Georgia,serif}.ld-planner__subtle{margin:4px 0 0;opacity:.7;font-size:12px}.ld-planner__actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ld-planner button,.ld-planner select,.ld-planner input{font:inherit}.ld-planner button{border:1px solid rgba(51,75,61,.2);border-radius:9px;padding:7px 10px;background:rgba(255,255,255,.58);color:inherit;cursor:pointer}.ld-planner button:hover,.ld-planner button:focus-visible{border-color:#7c9b82;background:rgba(255,255,255,.9);outline:2px solid rgba(106,142,113,.35);outline-offset:1px}.ld-planner__tabs button[aria-pressed=true]{background:#516e59;color:#fff;border-color:#516e59}.ld-planner__toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ld-planner__toolbar input{border:1px solid rgba(51,75,61,.22);border-radius:8px;padding:7px 8px;background:rgba(255,255,255,.76);color:inherit}.ld-planner__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ld-planner__quadrant{min-height:128px;border:1px solid rgba(51,75,61,.15);border-radius:13px;padding:12px;background:rgba(255,255,255,.38);transition:border-color .15s,background .15s}.ld-planner__quadrant.is-over{border-color:#789a7b;background:rgba(177,207,177,.26)}.ld-planner__quadrant h3{margin:0;font-size:14px}.ld-planner__hint{margin:3px 0 10px;font-size:11px;opacity:.65}.ld-planner__task{display:flex;align-items:center;gap:7px;width:100%;margin:5px 0;padding:7px;border-radius:8px;background:rgba(255,255,255,.72);border:1px solid rgba(51,75,61,.1);text-align:left}.ld-planner__task[draggable=true]{cursor:grab}.ld-planner__task:focus-within{outline:2px solid rgba(106,142,113,.45);outline-offset:1px}.ld-planner__task-name{flex:1;min-width:0;overflow-wrap:anywhere}.ld-planner__task-name button{border:0;background:none;padding:0;text-align:left;color:inherit;width:100%}.ld-planner__task-name small{display:block;font-size:10px;opacity:.62;margin-top:2px}.ld-planner__move{max-width:105px;padding:4px 5px!important;font-size:11px}.ld-planner__empty{margin:4px 0;font-size:12px;opacity:.58}.ld-planner__inbox{grid-column:1/-1;border-style:dashed}.ld-planner__plan{display:grid;gap:15px}.ld-planner__agenda{display:grid;gap:7px}.ld-planner__day{border:1px solid rgba(51,75,61,.12);border-radius:12px;padding:11px;background:rgba(255,255,255,.36);min-height:75px}.ld-planner__day h3{margin:0 0 8px;font-size:13px}.ld-planner__block{display:flex;align-items:center;gap:9px;padding:8px 9px;margin:5px 0;border-left:3px solid #789a7b;border-radius:8px;background:rgba(255,255,255,.76)}.ld-planner__block-main{flex:1;min-width:0}.ld-planner__block-time{font-size:11px;opacity:.68}.ld-planner__block-title{overflow-wrap:anywhere}.ld-planner__block-actions{display:flex;gap:3px}.ld-planner__block-actions button{padding:4px 7px;font-size:11px}.ld-planner__form{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;align-items:end;border-top:1px solid rgba(51,75,61,.12);padding-top:13px}.ld-planner__field{display:grid;gap:4px;font-size:11px}.ld-planner__field select,.ld-planner__field input{min-width:0;padding:8px;border:1px solid rgba(51,75,61,.2);border-radius:8px;background:rgba(255,255,255,.76);color:inherit}.ld-planner__form-actions{display:flex;gap:5px}.ld-planner__error{grid-column:1/-1;color:#a24f43;font-size:12px;margin:0}.ld-planner__week{display:grid;grid-template-columns:repeat(7,minmax(112px,1fr));gap:7px;overflow-x:auto}.ld-planner__week .ld-planner__day{min-width:112px}.ld-planner__week .ld-planner__block{display:block}.ld-planner__week .ld-planner__block-actions{margin-top:4px}@media(max-width:650px){.ld-planner__grid{grid-template-columns:1fr}.ld-planner__form{grid-template-columns:repeat(2,minmax(0,1fr))}.ld-planner__week{grid-template-columns:repeat(7,112px)}}@media(prefers-color-scheme:dark){.ld-planner{--sage-surface:rgba(37,56,45,.86);--sage-ink:#e8efe7}.ld-planner button,.ld-planner input,.ld-planner select,.ld-planner__task,.ld-planner__block,.ld-planner__day{background:rgba(255,255,255,.08);color:inherit}}
`;
  document.head.appendChild(style);
}

function getTaskLabel(task) {
  return task?.text || 'Untitled task';
}

function moveQuadrant(current, direction) {
  const index = QUADRANTS.indexOf(current);
  const from = index < 0 ? (direction > 0 ? -1 : QUADRANTS.length) : index;
  return QUADRANTS[(from + direction + QUADRANTS.length) % QUADRANTS.length];
}

function buildTaskRow(task, quadrant, callbacks) {
  const row = el('div', 'ld-planner__task');
  row.dataset.taskId = task.id;
  row.draggable = true;
  row.tabIndex = 0;
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-label', `${getTaskLabel(task)}. ${QUADRANT_LABELS[quadrant] || 'Unclassified'}`);
  row.addEventListener('dragstart', event => {
    event.dataTransfer?.setData('text/plain', task.id);
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
  row.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    callbacks.onTaskUpdate?.(task.id, { quadrant: moveQuadrant(quadrant, event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) });
  });

  const main = el('div', 'ld-planner__task-name');
  const focus = button(getTaskLabel(task), '', () => callbacks.onFocusTask?.(task.id));
  focus.setAttribute('aria-label', `Focus ${getTaskLabel(task)}`);
  main.appendChild(focus);
  const meta = el('small', '', `${task.priority || 'medium'}${task.done ? ' · done' : ''}`);
  main.appendChild(meta);
  row.appendChild(main);

  const move = document.createElement('select');
  move.className = 'ld-planner__move';
  move.setAttribute('aria-label', `Move ${getTaskLabel(task)}`);
  const unclassified = new Option('Unclassified', '');
  move.appendChild(unclassified);
  for (const value of QUADRANTS) move.appendChild(new Option(QUADRANT_LABELS[value], value));
  move.value = quadrant || '';
  move.addEventListener('change', () => callbacks.onTaskUpdate?.(task.id, { quadrant: move.value || null }));
  row.appendChild(move);
  return row;
}

function renderMatrix(root, state, list, callbacks) {
  const tasks = taskList(state, list);
  const grid = el('div', 'ld-planner__grid');
  grid.setAttribute('aria-label', 'Eisenhower matrix');
  const groups = [...QUADRANTS, null];
  for (const quadrant of groups) {
    const section = el('section', `ld-planner__quadrant${quadrant === null ? ' ld-planner__inbox' : ''}`);
    section.dataset.quadrant = quadrant || '';
    section.setAttribute('role', 'list');
    const title = quadrant ? QUADRANT_LABELS[quadrant] : 'Unclassified';
    section.appendChild(el('h3', '', title));
    section.appendChild(el('p', 'ld-planner__hint', quadrant ? QUADRANT_HINTS[quadrant] : 'Classify an intention before scheduling it'));
    const groupTasks = tasks.filter(task => (task.quadrant || null) === quadrant);
    if (!groupTasks.length) section.appendChild(el('p', 'ld-planner__empty', 'Drop a task here'));
    for (const task of groupTasks) section.appendChild(buildTaskRow(task, quadrant, callbacks));
    section.addEventListener('dragover', event => { event.preventDefault(); section.classList.add('is-over'); });
    section.addEventListener('dragleave', event => { if (!section.contains(event.relatedTarget)) section.classList.remove('is-over'); });
    section.addEventListener('drop', event => {
      event.preventDefault();
      section.classList.remove('is-over');
      const id = event.dataTransfer?.getData('text/plain');
      if (id) callbacks.onTaskUpdate?.(id, { quadrant });
    });
    grid.appendChild(section);
  }
  root.appendChild(grid);
}

function formatDay(date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(asDate(value));
}

function taskMap(state) {
  return new Map(allTasks(state).map(task => [task.id, task]));
}

function renderBlock(block, tasks, callbacks, startEdit) {
  const item = el('article', 'ld-planner__block');
  const main = el('div', 'ld-planner__block-main');
  main.appendChild(el('div', 'ld-planner__block-time', `${formatTime(block.startAt)}–${formatTime(block.endAt)}`));
  const linkedTask = tasks.get(block.taskId);
  const title = button(getTaskLabel(linkedTask) || 'Unlinked task', 'ld-planner__block-title', () => callbacks.onFocusTask?.(block.taskId));
  main.appendChild(title);
  item.appendChild(main);
  const actions = el('div', 'ld-planner__block-actions');
  actions.appendChild(button('Edit', '', () => startEdit(block)));
  actions.appendChild(button('Delete', '', () => callbacks.onBlockDelete?.(block.id)));
  item.appendChild(actions);
  item.draggable=true;item.addEventListener('dragstart',event=>event.dataTransfer?.setData('application/loughdin',JSON.stringify({id:block.id,taskId:block.taskId,duration:(new Date(block.endAt)-new Date(block.startAt))/MINUTE})));
  return item;
}

function renderPlan(root, state, callbacks, planState) {
  const plan = el('div', 'ld-planner__plan');
  const selected = dateFromKey(planState.dateKey);
  const range = rangeForDate(selected, planState.range);
  const blocks = Array.isArray(state?.blocks) ? state.blocks : [];
  const visibleBlocks = blocksForRange(blocks, range.start, range.end);
  const tasks = taskMap(state);
  const days = planState.range === 'week' ? Array.from({ length: 7 }, (_, index) => addLocalDays(range.start, index)) : [selected];
  const agenda = el('div', planState.range === 'week' ? 'ld-planner__week' : 'ld-planner__agenda');
  for (const day of days) {
    const dayStart = dateFromKey(localDateKey(day)); dayStart.setHours(0,0,0,0);
    const dayEnd = addLocalDays(dayStart, 1);
    const daySection = el('section', 'ld-planner__day');
    daySection.appendChild(el('h3', '', formatDay(day)));
    const dayBlocks = blocksForRange(visibleBlocks, dayStart, dayEnd).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    if (!dayBlocks.length) daySection.appendChild(el('p', 'ld-planner__empty', 'No blocks planned'));
    for (const block of dayBlocks) {
      daySection.appendChild(renderBlock(block, tasks, callbacks, blockToEdit => {
        planState.startEdit(blockToEdit);
        root.querySelector('.ld-planner__plan')?.remove();
        renderPlan(root, state, callbacks, planState);
      }));
    }
    agenda.appendChild(daySection);
  }
  plan.appendChild(agenda);

  const form = el('form', 'ld-planner__form');
  form.noValidate = true;
  const taskField = el('label', 'ld-planner__field', 'Task');
  const taskSelect = document.createElement('select');
  taskSelect.name = 'taskId';
  for (const task of allTasks(state).filter(task => !task.done)) taskSelect.appendChild(new Option(getTaskLabel(task), task.id));
  taskField.appendChild(taskSelect);
  form.appendChild(taskField);
  const dateField = el('label', 'ld-planner__field', 'Date');
  const dateInput = document.createElement('input');
  dateInput.type = 'date'; dateInput.name = 'date'; dateInput.required = true; dateInput.value = planState.form.date;
  dateField.appendChild(dateInput); form.appendChild(dateField);
  const timeField = el('label', 'ld-planner__field', 'Start');
  const timeInput = document.createElement('input');
  timeInput.type = 'time'; timeInput.name = 'time'; timeInput.required = true; timeInput.step = 300; timeInput.value = planState.form.time;
  timeField.appendChild(timeInput); form.appendChild(timeField);
  const durationField = el('label', 'ld-planner__field', 'Minutes');
  const durationInput = document.createElement('input');
  durationInput.type = 'number'; durationInput.name = 'duration'; durationInput.min = '5'; durationInput.step = '5'; durationInput.value = String(planState.form.duration);
  durationField.appendChild(durationInput); form.appendChild(durationField);
  const error = el('p', 'ld-planner__error');
  error.hidden = true; error.setAttribute('role', 'alert'); form.appendChild(error);
  const formActions = el('div', 'ld-planner__form-actions');
  const submit = button(planState.form.editingId ? 'Save changes' : 'Add block');
  submit.type = 'submit'; submit.disabled=!!planState.pending;
  formActions.appendChild(submit);
  if (planState.form.editingId) formActions.appendChild(button('Cancel', '', () => { planState.resetForm(); root.querySelector('.ld-planner__plan')?.remove(); renderPlan(root, state, callbacks, planState); }));
  form.appendChild(formActions);
  if (planState.form.taskId) taskSelect.value = planState.form.taskId;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const start = fromLocalInputs(dateInput.value, timeInput.value);
      const duration = snapMinutes(Number(durationInput.value), 5);
      const end = new Date(start.getTime() + duration * MINUTE);
      const block = { id: planState.form.editingId || createId(), taskId: taskSelect.value, startAt: start.toISOString(), endAt: end.toISOString() };
      const result = validateBlock(block, blocks);
      if (!result.ok) { error.hidden = false; text(error, result.error); return; }
      submit.disabled = true; planState.pending=true;
      await callbacks.onBlockSave?.(block);
      planState.pending=false; planState.resetForm();
      renderInto(root,latestInput,callbacks,planState);
    } catch (cause) {
      planState.pending=false; submit.disabled = false; error.hidden = false; text(error, cause.message || 'Enter a valid date and time.');
    }
  });
  plan.appendChild(form);
  root.appendChild(plan);
  renderScheduleGrid(root,state,callbacks,planState,days);
}

export function placementForDrop(taskId,dateKey,minutes,duration=25,id=createId()){
  const start=fromLocalInputs(dateKey,'00:00');
  start.setMinutes(snapMinutes(minutes));
  return {id,taskId,startAt:start.toISOString(),endAt:new Date(start.getTime()+Math.max(5,duration)*MINUTE).toISOString()};
}
function renderScheduleGrid(root,state,callbacks,planState,days){
  const details=el('details','ld-schedule');details.open=planState.range==='day';details.append(el('summary','','Drag to schedule'));
  const tray=el('div','ld-schedule__tray');
  for(const task of allTasks(state).filter(t=>!t.done)){
    const chip=button(task.text,'',()=>{planState.form.taskId=task.id;root.querySelector('select[name=taskId]').value=task.id;root.querySelector('input[name=time]').focus();});
    chip.draggable=true;chip.addEventListener('dragstart',event=>event.dataTransfer?.setData('application/loughdin',JSON.stringify({taskId:task.id,duration:task.estimateMinutes||25})));tray.append(chip);
  }
  details.append(tray);
  const grid=el('div','ld-schedule__grid');
  for(const day of days){const column=el('div','ld-schedule__day');column.append(el('strong','',formatDay(day)));
    for(let hour=0;hour<24;hour++){
      const slot=button(pad(hour)+':00','ld-schedule__slot',()=>{planState.form.date=localDateKey(day);planState.form.time=pad(hour)+':00';const date=root.querySelector('input[name=date]');const time=root.querySelector('input[name=time]');date.value=planState.form.date;time.value=planState.form.time;time.focus();});
      slot.setAttribute('aria-label','Schedule at '+pad(hour)+':00 on '+localDateKey(day));
      slot.addEventListener('dragover',event=>{event.preventDefault();slot.classList.add('is-over');});slot.addEventListener('dragleave',()=>slot.classList.remove('is-over'));
      slot.addEventListener('drop',async event=>{event.preventDefault();slot.classList.remove('is-over');try{const data=JSON.parse(event.dataTransfer.getData('application/loughdin'));const fraction=Math.max(0,Math.min(1,(event.clientY-slot.getBoundingClientRect().top)/slot.getBoundingClientRect().height));const block=placementForDrop(data.taskId,localDateKey(day),hour*60+fraction*60,data.duration,data.id);const valid=validateBlock(block,state.blocks);if(!valid.ok)throw Error(valid.error);await callbacks.onBlockSave(block);}catch(e){const error=root.querySelector('.ld-planner__error');error.hidden=false;error.textContent=e.message;}});
      column.append(slot);
    }grid.append(column);
  }details.append(grid);root.querySelector('.ld-planner__plan').prepend(details);
}
function makePlanState() {
  const state = { range: 'day', dateKey: localDateKey(), form: { taskId: '', date: localDateKey(), time: '09:00', duration: 25, editingId: null } };
  state.resetForm = () => { state.form = { taskId: '', date: state.dateKey, time: '09:00', duration: 25, editingId: null }; };
  state.startEdit = block => {
    const start = toLocalInputParts(block.startAt);
    state.form = { taskId: block.taskId || '', date: start.date, time: start.time, duration: Math.max(5, Math.round((new Date(block.endAt) - new Date(block.startAt)) / MINUTE / 5) * 5), editingId: block.id };
  };
  return state;
}

let latestInput = null;
let mountedContainer = null;
let mountedCallbacks = {};
let mountedPlanState = null;

function renderInto(container, input, callbacks, planState) {
  latestInput = input;
  ensureStyles();
  const state = input?.state || { tasks: { work: [], personal: [] }, blocks: [] };
  const list = input?.list === 'personal' ? 'personal' : 'work';
  const view = input?.view === 'plan' ? 'plan' : input?.view === 'matrix' ? 'matrix' : null;
  container.replaceChildren();
  container.classList.add('ld-planner');
  container.hidden = !view;
  if (!view) return container;

  const heading = el('div', 'ld-planner__header');
  const headingCopy = el('div');
  headingCopy.appendChild(el('h2', 'ld-planner__title', view === 'matrix' ? 'Plan by intention' : 'Plan your time'));
  headingCopy.appendChild(el('p', 'ld-planner__subtle', view === 'matrix' ? 'Move an intention into the quadrant that fits.' : 'Blocks reserve time for a task; adjacent blocks can touch.'));
  heading.appendChild(headingCopy);
  if (view === 'matrix') {
    const tabs = el('div', 'ld-planner__actions ld-planner__tabs');
    const matrix = button('Matrix', '', () => callbacks.onViewChange?.('matrix')); matrix.setAttribute('aria-pressed', 'true');
    const plan = button('Plan', '', () => callbacks.onViewChange?.('plan')); plan.setAttribute('aria-pressed', 'false');
    tabs.append(matrix, plan); heading.appendChild(tabs); container.appendChild(heading); renderMatrix(container, state, list, callbacks); return container;
  }

  const toolbar = el('div', 'ld-planner__toolbar');
  const previous = button('Previous', '', () => { planState.dateKey = localDateKey(addLocalDays(dateFromKey(planState.dateKey), planState.range === 'week' ? -7 : -1)); planState.form.date = planState.dateKey; renderInto(container, input, callbacks, planState); });
  const next = button('Next', '', () => { planState.dateKey = localDateKey(addLocalDays(dateFromKey(planState.dateKey), planState.range === 'week' ? 7 : 1)); planState.form.date = planState.dateKey; renderInto(container, input, callbacks, planState); });
  const date = document.createElement('input'); date.type = 'date'; date.value = planState.dateKey; date.setAttribute('aria-label', 'Planner date'); date.addEventListener('change', () => { planState.dateKey = date.value || localDateKey(); planState.form.date = planState.dateKey; renderInto(container, input, callbacks, planState); });
  toolbar.append(previous, date, next);
  for (const range of ['day', 'week']) { const control = button(range[0].toUpperCase() + range.slice(1), '', () => { planState.range = range; renderInto(container, input, callbacks, planState); }); control.setAttribute('aria-pressed', String(planState.range === range)); toolbar.appendChild(control); }
  const matrix = button('Matrix', '', () => callbacks.onViewChange?.('matrix')); toolbar.appendChild(matrix);
  heading.appendChild(toolbar); container.appendChild(heading); renderPlan(container, state, callbacks, planState); return container;
}

/** Render the planner into an existing container. mountPlanner is usually easier for app code. */
export function renderPlanner({ container, state, list = 'work', view = 'matrix', callbacks = {}, planState } = {}) {
  const target = container || mountedContainer;
  if (!target) throw new TypeError('renderPlanner requires a container or a mounted planner');
  const effectiveCallbacks = Object.keys(callbacks).length ? callbacks : mountedCallbacks;
  return renderInto(target, { state, list, view }, effectiveCallbacks, planState || mountedPlanState || makePlanState());
}

export function mountPlanner(container, callbacks = {}) {
  if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('mountPlanner requires a DOM container');
  const planState = makePlanState();
  let latest = { state: { tasks: { work: [], personal: [] }, blocks: [] }, list: 'work', view: null };
  const mountCallbacks = {
    ...callbacks,
    onViewChange(view) {
      if (callbacks.onViewChange) callbacks.onViewChange(view);
      else render({ view });
    },
  };
  mountedContainer = container;
  mountedCallbacks = mountCallbacks;
  mountedPlanState = planState;
  const render = input => {
    latest = { ...latest, ...(input || {}) };
    return renderInto(container, latest, mountCallbacks, planState);
  };
  return {
    render,
    update: render,
    destroy() { container.replaceChildren(); container.hidden = true; },
    get input() { return { ...latest }; },
  };
}
