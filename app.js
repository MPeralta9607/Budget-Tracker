
(function(){
  const DEFAULT_CATS = [
    {id:'food', label:'Food & Dining', color:'#c1583d', bucket:'needs'},
    {id:'transport', label:'Transport', color:'#d4a24c', bucket:'needs'},
    {id:'housing', label:'Housing', color:'#63ab8f', bucket:'needs'},
    {id:'utilities', label:'Utilities', color:'#7a93a8', bucket:'needs'},
    {id:'health', label:'Health', color:'#6fbf73', bucket:'needs'},
    {id:'shopping', label:'Shopping', color:'#a888c7', bucket:'wants'},
    {id:'entertainment', label:'Entertainment', color:'#c77f9e', bucket:'wants'},
    {id:'other', label:'Other', color:'#8d979c', bucket:'wants'},
    {id:'savings', label:'Savings & Investing', color:'#5f8fa8', bucket:'savings'},
  ];
  // Extra colors handed out to user-created categories, in order, skipping any already in use.
  const COLOR_PALETTE = ['#e0a55c','#7fb0d8','#d67ab8','#8fbf6f','#c99a4a','#5fa8a0','#b57bd6','#d47a6a','#6f9ac7','#9fbf5f'];
  const STORE_KEY = 'finance-tracker-data';
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const WEEKDAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  let data = { budgets:{}, categoryBudgets:{}, categories: DEFAULT_CATS.map(c=>({...c})), goal:null, openingSavings:0, expenses:[], income:[], recurring:[], recurringSkips:[] };
  const REPEAT_UNITS = ['days','weeks','months','years'];
  // Legacy hardcoded frequencies -> generic {interval, unit}
  const LEGACY_FREQUENCY_MAP = {
    weekly: { repeatInterval:1, repeatUnit:'weeks' },
    biweekly: { repeatInterval:2, repeatUnit:'weeks' },
    monthly: { repeatInterval:1, repeatUnit:'months' },
    yearly: { repeatInterval:1, repeatUnit:'years' }
  };
  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let chart = null;
  let entryMode = 'expense'; // or 'income'
  let editingEntry = null; // { type: 'expense'|'income', id: string }
  let searchState = { query: '', kind: 'all' };
  let goalSheetMode = 'opening';

  const $ = id => document.getElementById(id);
  const fmt = n => '$' + (Math.round(n*100)/100).toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2});
  const monthKey = (y,m) => `${y}-${String(m+1).padStart(2,'0')}`;
  const catInfo = id => data.categories.find(c=>c.id===id) || data.categories[data.categories.length-1];

  function parseLocalDate(iso){
    if(!iso) return null;
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function toLocalISO(date){
    const y = date.getFullYear();
    const m = String(date.getMonth()+1).padStart(2,'0');
    const d = String(date.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  function prettyDate(date){
    return date.toLocaleDateString('en-US',{month:'short', day:'numeric', year:'numeric'});
  }
  function recurringKey(ruleId, isoDate){
    return `${ruleId}|${isoDate}`;
  }
  function ruleRepeat(rule){
    const interval = Math.max(1, parseInt(rule && rule.repeatInterval, 10) || 1);
    let unit = rule && rule.repeatUnit;
    if(!REPEAT_UNITS.includes(unit)) unit = 'months';
    return { interval, unit };
  }
  function normalizeWeekDays(rule){
    if(!rule || (rule.repeatUnit !== 'weeks' && !Array.isArray(rule.weekDays) && rule.weekDay == null)) return [];
    const source = Array.isArray(rule.weekDays)
      ? rule.weekDays
      : (rule.weekDay == null ? [] : [rule.weekDay]);
    const days = source
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value >= 0 && value <= 6);
    if(days.length) return [...new Set(days)].sort((a,b) => a - b);
    const start = parseLocalDate(rule.startDate);
    return start ? [start.getDay()] : [1];
  }
  function setWeekdayPicker(days){
    const selected = new Set((days || []).map(Number).filter(value => Number.isInteger(value) && value >= 0 && value <= 6));
    $('weekdayPicker').querySelectorAll('button[data-day]').forEach(btn => {
      btn.classList.toggle('active', selected.has(Number(btn.getAttribute('data-day'))));
    });
    const allSelected = selected.size === 7;
    $('weekdayAllBtn').classList.toggle('active', allSelected);
  }
  function getWeekdayPickerSelection(){
    return Array.from($('weekdayPicker').querySelectorAll('button[data-day].active'))
      .map(btn => Number(btn.getAttribute('data-day')))
      .filter(value => Number.isInteger(value) && value >= 0 && value <= 6)
      .sort((a,b) => a - b);
  }
  function isWeeklyOccurrence(rule, date){
    const start = parseLocalDate(rule && rule.startDate);
    if(!start || !date) return false;
    if(date < start) return false;
    const selectedDays = normalizeWeekDays(rule);
    if(!selectedDays.includes(date.getDay())) return false;
    const { interval } = ruleRepeat(rule);
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const startWeek = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    startWeek.setDate(startWeek.getDate() - startWeek.getDay());
    const candidateWeek = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    candidateWeek.setDate(candidateWeek.getDate() - candidateWeek.getDay());
    const weekDiff = Math.floor((candidateWeek.getTime() - startWeek.getTime()) / weekMs);
    return weekDiff >= 0 && (weekDiff % interval === 0);
  }
  function nextWeeklyOccurrence(rule){
    const start = parseLocalDate(rule && rule.startDate);
    if(!start) return null;
    const todayDate = parseLocalDate(toLocalISO(new Date()));
    const until = rule.untilDate ? parseLocalDate(rule.untilDate) : null;
    let current = start < todayDate ? new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate()) : new Date(start.getFullYear(), start.getMonth(), start.getDate());
    if(current < start) current = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let guard = 0;
    while(guard < 2000){
      guard++;
      if(until && current > until) return null;
      if(isWeeklyOccurrence(rule, current) && current >= start && current >= todayDate) return current;
      current.setDate(current.getDate() + 1);
    }
    return null;
  }
  function weeklyOccurrencesBetween(rule, fromDate, toDate){
    const start = parseLocalDate(rule && rule.startDate);
    if(!start || !fromDate || !toDate) return [];
    const until = rule.untilDate ? parseLocalDate(rule.untilDate) : null;
    const out = [];
    let current = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let guard = 0;
    while(current <= toDate && guard < 4000){
      guard++;
      if(until && current > until) break;
      if(current > fromDate && isWeeklyOccurrence(rule, current)) out.push(new Date(current.getFullYear(), current.getMonth(), current.getDate()));
      current.setDate(current.getDate() + 1);
    }
    return out;
  }
  function addRecurringStep(date, interval, unit){
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if(unit === 'days'){
      next.setDate(next.getDate() + interval);
      return next;
    }
    if(unit === 'weeks'){
      next.setDate(next.getDate() + (interval * 7));
      return next;
    }
    const day = next.getDate();
    next.setDate(1);
    if(unit === 'years'){
      next.setFullYear(next.getFullYear() + interval);
    } else {
      next.setMonth(next.getMonth() + interval);
    }
    const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, last));
    return next;
  }
  function nextRecurringDate(rule){
    const start = parseLocalDate(rule.startDate);
    if(!start) return null;
    const { interval, unit } = ruleRepeat(rule);
    const todayDate = parseLocalDate(toLocalISO(new Date()));
    const until = rule.untilDate ? parseLocalDate(rule.untilDate) : null;
    if(until && start > until) return null;
    if(unit === 'weeks'){
      return nextWeeklyOccurrence(rule);
    }
    let current = start;
    while(current < todayDate){
      const next = addRecurringStep(current, interval, unit);
      if(next.getTime() === current.getTime()) break;
      current = next;
      if(until && current > until) return null;
    }
    return current;
  }
  // Enumerate occurrence dates of a rule strictly after `fromDate` and up to and including `toDate`.
  function upcomingRecurringOccurrences(rule, fromDate, toDate){
    const start = parseLocalDate(rule.startDate);
    if(!start) return [];
    const { interval, unit } = ruleRepeat(rule);
    const until = rule.untilDate ? parseLocalDate(rule.untilDate) : null;
    if(unit === 'weeks'){
      return weeklyOccurrencesBetween(rule, fromDate, toDate);
    }
    const out = [];
    let current = start;
    let guard = 0;
    while(current <= toDate && guard < 2000){
      guard++;
      if(until && current > until) break;
      if(current > fromDate && current <= toDate) out.push(current);
      const next = addRecurringStep(current, interval, unit);
      if(next.getTime() === current.getTime()) break;
      current = next;
    }
    return out;
  }
  function materializeRecurringEntries(){
    if(!Array.isArray(data.recurring)) data.recurring = [];
    if(!Array.isArray(data.recurringSkips)) data.recurringSkips = [];

    const todayDate = parseLocalDate(toLocalISO(new Date()));
    const existingExpense = new Set(
      data.expenses
        .filter(e => e.recurringId && e.recurringDate)
        .map(e => recurringKey(e.recurringId, e.recurringDate))
    );
    const existingIncome = new Set(
      data.income
        .filter(i => i.recurringId && i.recurringDate)
        .map(i => recurringKey(i.recurringId, i.recurringDate))
    );
    const skipped = new Set(data.recurringSkips);

    data.recurring.forEach(rule => {
      if(!rule || rule.active === false) return;
      const type = rule.type || 'expense';
      if(type !== 'expense' && type !== 'income' && type !== 'savings') return;
      let current = parseLocalDate(rule.startDate);
      if(!current) return;
      const until = rule.untilDate ? parseLocalDate(rule.untilDate) : null;
      const { interval, unit } = ruleRepeat(rule);
      const label = recurringFrequencyLabel(rule);

      if(unit === 'weeks'){
        let guard = 0;
        while(current <= todayDate && guard < 4000){
          guard++;
          if(until && current > until) break;
          if(isWeeklyOccurrence(rule, current)){
            const iso = toLocalISO(current);
            const key = recurringKey(rule.id, iso);
            if(type === 'income'){
              if(!skipped.has(key) && !existingIncome.has(key)){
                data.income.push({
                  id: 'i' + Date.now() + Math.random().toString(36).slice(2,7),
                  amount: rule.amount,
                  source: rule.note || rule.source || '',
                  date: iso,
                  recurringId: rule.id,
                  recurringDate: iso,
                  recurringLabel: label
                });
                existingIncome.add(key);
              }
            } else {
              if(!skipped.has(key) && !existingExpense.has(key)){
                data.expenses.push({
                  id: 'e' + Date.now() + Math.random().toString(36).slice(2,7),
                  amount: rule.amount,
                  category: type === 'savings' ? 'savings' : rule.category,
                  note: rule.note || '',
                  fundedBy: type === 'savings' ? 'budget' : (rule.fundedBy === 'savings' ? 'savings' : 'budget'),
                  date: iso,
                  recurringId: rule.id,
                  recurringDate: iso,
                  recurringLabel: label
                });
                existingExpense.add(key);
              }
            }
          }
          current.setDate(current.getDate() + 1);
        }
        return;
      }

      while(current <= todayDate){
        if(until && current > until) break;
        const iso = toLocalISO(current);
        const key = recurringKey(rule.id, iso);

        if(type === 'income'){
          if(!skipped.has(key) && !existingIncome.has(key)){
            data.income.push({
              id: 'i' + Date.now() + Math.random().toString(36).slice(2,7),
              amount: rule.amount,
              source: rule.note || rule.source || '',
              date: iso,
              recurringId: rule.id,
              recurringDate: iso,
              recurringLabel: label
            });
            existingIncome.add(key);
          }
        } else {
          if(!skipped.has(key) && !existingExpense.has(key)){
            data.expenses.push({
              id: 'e' + Date.now() + Math.random().toString(36).slice(2,7),
              amount: rule.amount,
              category: type === 'savings' ? 'savings' : rule.category,
              note: rule.note || '',
              fundedBy: type === 'savings' ? 'budget' : (rule.fundedBy === 'savings' ? 'savings' : 'budget'),
              date: iso,
              recurringId: rule.id,
              recurringDate: iso,
              recurringLabel: label
            });
            existingExpense.add(key);
          }
        }
        current = addRecurringStep(current, interval, unit);
      }
    });
  }
  function recurringFrequencyLabel(rule){
    const { interval, unit } = ruleRepeat(rule);
    if(unit === 'weeks'){
      const days = normalizeWeekDays(rule);
      if(days.length === 7){
        return interval === 1 ? 'All week' : `Every ${interval} weeks, all week`;
      }
      const names = days.map(day => WEEKDAY_NAMES[day] || 'Day');
      const dayText = names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return interval === 1 ? `Every ${dayText}` : `Every ${interval} weeks on ${dayText}`;
    }
    const unitLabel = unit.charAt(0).toUpperCase() + unit.slice(1);
    const singularUnit = unitLabel.slice(0, -1); // Days->Day, Weeks->Week, etc.
    return interval === 1 ? `Every ${singularUnit}` : `Every ${interval} ${unitLabel}`;
  }
  function markRecurringSkip(item){
    if(item && item.recurringId && item.recurringDate){
      const key = recurringKey(item.recurringId, item.recurringDate);
      if(!data.recurringSkips.includes(key)) data.recurringSkips.push(key);
    }
  }

  // ---------- storage ----------
  // Uses Claude's cloud storage when previewing inside Claude (window.storage).
  // Falls back to the browser's own localStorage when running standalone
  // (e.g. saved to the iPhone home screen), and never blocks longer than
  // a couple seconds so the app can't get stuck on "loading".
  function withTimeout(promise, ms){
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('storage timeout')), ms))
    ]);
  }
  function normalize(parsed){
    const categories = (parsed && Array.isArray(parsed.categories) && parsed.categories.length)
      ? parsed.categories
      : DEFAULT_CATS.map(c=>({...c}));

    const recurring = ((parsed && parsed.recurring) || []).map(r => {
      if(!r) return r;
      const rule = { ...r };
      if(!rule.type) rule.type = 'expense';
      if(rule.repeatInterval == null || rule.repeatUnit == null || !REPEAT_UNITS.includes(rule.repeatUnit)){
        const legacy = LEGACY_FREQUENCY_MAP[rule.frequency] || LEGACY_FREQUENCY_MAP.monthly;
        rule.repeatInterval = legacy.repeatInterval;
        rule.repeatUnit = legacy.repeatUnit;
      }
      if(rule.repeatUnit === 'weeks'){
        const existingDays = normalizeWeekDays(rule);
        rule.weekDays = existingDays.length ? existingDays : normalizeWeekDays({ startDate: rule.startDate, repeatUnit: 'weeks' });
      } else if(rule.weekDays){
        delete rule.weekDays;
      }
      if(rule.type === 'expense' && rule.category !== 'savings' && rule.fundedBy !== 'savings') rule.fundedBy = 'budget';
      return rule;
    });

    const expenses = ((parsed && parsed.expenses) || []).map(e => {
      if(!e) return e;
      if(e.category === 'savings') return e; // savings contributions are never "withdrawals"
      return e.fundedBy === 'savings' ? e : { ...e, fundedBy: 'budget' };
    });

    return {
      budgets: (parsed && parsed.budgets) || {},
      categoryBudgets: (parsed && parsed.categoryBudgets) || {},
      categories,
      goal: (parsed && parsed.goal) || null,
      openingSavings: (parsed && typeof parsed.openingSavings === 'number') ? parsed.openingSavings : 0,
      expenses,
      income: (parsed && parsed.income) || [],
      recurring,
      recurringSkips: (parsed && parsed.recurringSkips) || []
    };
  }
  async function loadData(){
    let loaded = false;
    if(window.storage && typeof window.storage.get === 'function'){
      try{
        const res = await withTimeout(window.storage.get(STORE_KEY, false), 1800);
        if(res && res.value){ data = normalize(JSON.parse(res.value)); loaded = true; }
      }catch(e){
        console.log('Cloud storage unavailable here, falling back to on-device storage.');
      }
    }
    if(!loaded){
      try{
        const raw = localStorage.getItem(STORE_KEY);
        if(raw){ data = normalize(JSON.parse(raw)); }
      }catch(e){
        console.log('No existing on-device ledger data yet.');
      }
    }
  }
  async function saveData(){
    materializeRecurringEntries();
    try{ localStorage.setItem(STORE_KEY, JSON.stringify(data)); }catch(e){ /* ignore */ }
    if(window.storage && typeof window.storage.set === 'function'){
      try{
        await withTimeout(window.storage.set(STORE_KEY, JSON.stringify(data), false), 1800);
      }catch(e){
        console.log('Cloud save unavailable, kept on-device copy.');
      }
    }
  }

  function getBudgetFor(y,m){
    const key = monthKey(y,m);
    if(data.budgets[key] != null) return data.budgets[key];
    return 0;
  }

  // Keeps the monthly budget synced to that month's total income.
  function syncBudgetsToIncome(){
    const totals = {};
    data.income.forEach(i => {
      const key = i.date.slice(0,7);
      totals[key] = (totals[key] || 0) + i.amount;
    });

    const keys = new Set([
      ...Object.keys(data.budgets),
      ...Object.keys(totals),
      ...data.income.map(i => i.date.slice(0,7))
    ]);

    keys.forEach(key => {
      data.budgets[key] = totals[key] || 0;
    });
  }

  function getCategoryBudgetFor(y,m,catId){
    const key = monthKey(y,m);
    const thisMonth = data.categoryBudgets[key];
    if(thisMonth && thisMonth[catId] != null) return thisMonth[catId];
    const priorKeys = Object.keys(data.categoryBudgets).filter(k => k < key).sort().reverse();
    for(const k of priorKeys){
      if(data.categoryBudgets[k] && data.categoryBudgets[k][catId] != null) return data.categoryBudgets[k][catId];
    }
    return 0;
  }

  function nextCategoryColor(){
    const used = new Set(data.categories.map(c=>c.color));
    const free = COLOR_PALETTE.find(c => !used.has(c));
    if(free) return free;
    // palette exhausted — derive a distinct-ish color from a hue rotation
    const hue = (data.categories.length * 47) % 360;
    return `hsl(${hue},55%,60%)`;
  }

  function slugify(name){
    let base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
    if(!base) base = 'category';
    let id = base, n = 2;
    while(data.categories.some(c=>c.id===id)){ id = `${base}-${n++}`; }
    return id;
  }

  function expensesFor(y,m){
    const key = monthKey(y,m);
    return data.expenses
      .filter(e => e.date.slice(0,7) === key)
      .sort((a,b)=> a.date < b.date ? 1 : -1);
  }
  function incomeFor(y,m){
    const key = monthKey(y,m);
    return data.income
      .filter(i => i.date.slice(0,7) === key)
      .sort((a,b)=> a.date < b.date ? 1 : -1);
  }

  function populateCategorySelect(){
    const sel = $('inpCategory');
    const prevVal = sel.value;
    sel.innerHTML = data.categories.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
    if(data.categories.some(c=>c.id===prevVal)) sel.value = prevVal;
  }

  function renderHeader(){
    $('monthLabel').textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;
    const isCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();
    const headerDate = isCurrentMonth ? new Date() : new Date(viewYear, viewMonth, 1);
    $('monthDate').textContent = prettyDate(headerDate);
  }

  function renderSummary(){
    const budget = getBudgetFor(viewYear, viewMonth);
    const exps = expensesFor(viewYear, viewMonth);
    const incs = incomeFor(viewYear, viewMonth);
    const spent = budgetableExpenses(exps).reduce((s,e)=>s+e.amount,0);
    const income = incs.reduce((s,i)=>s+i.amount,0);
    const balance = income - spent;

    $('incomeNum').textContent = fmt(income);
    $('spentNum').textContent = fmt(spent);
    $('balanceNum').textContent = fmt(Math.abs(balance));
    $('balanceNum').className = 'num balance ' + (balance < 0 ? 'over' : 'under');
    $('budgetNum').textContent = fmt(budget);

    const pct = budget > 0 ? Math.min(100, (spent/budget)*100) : (spent > 0 ? 100 : 0);
    const fill = $('tapeFill');
    fill.style.width = pct + '%';
    fill.className = 'tape-fill' + (spent > budget && budget > 0 ? ' over' : '');

    const isCurrent = (viewYear === today.getFullYear() && viewMonth === today.getMonth());
    const daysInMonth = new Date(viewYear, viewMonth+1, 0).getDate();
    const dayOfMonth = isCurrent ? today.getDate() : daysInMonth;

    if(budget === 0){
      $('tapeCaption').textContent = 'Monthly budget matches income, so it updates whenever you add or edit a paycheck.';
    } else {
      const usedPct = Math.round((spent/budget)*100);
      $('tapeCaption').textContent = isCurrent
        ? `Day ${dayOfMonth} of ${daysInMonth} — ${usedPct}% of income budget used`
        : `${daysInMonth} days — ${usedPct}% of income budget used`;
    }
  }

  function bucketTotals(y,m){
    const exps = budgetableExpenses(expensesFor(y,m));
    const totals = {needs:0, wants:0, savings:0};
    exps.forEach(e => { totals[catInfo(e.category).bucket] += e.amount; });
    return totals;
  }

  function renderRule(){
    const income = incomeFor(viewYear, viewMonth).reduce((s,i)=>s+i.amount,0);
    const totals = bucketTotals(viewYear, viewMonth);
    const leftover = income - (totals.needs + totals.wants + totals.savings);
    const impliedSavings = totals.savings + Math.max(0, leftover);

    if(income === 0){
      $('ruleSub').textContent = 'Add a paycheck to see how your spending compares to the 50/30/20 rule.';
      ['needs','wants','savings'].forEach(b => {
        $(b+'Fill').style.width = '0%';
        $(b+'Fill').className = 'rule-fill good';
        $(b+'Amt').textContent = '—';
      });
      return;
    }
    $('ruleSub').textContent = `Based on ${fmt(income)} of income logged this month`;

    const needsPct = (totals.needs/income)*100;
    const wantsPct = (totals.wants/income)*100;
    const savingsPct = (impliedSavings/income)*100;

    setRuleBar('needs', needsPct, 50, totals.needs, income, false);
    setRuleBar('wants', wantsPct, 30, totals.wants, income, false);
    setRuleBar('savings', savingsPct, 20, impliedSavings, income, true);
  }
  function setRuleBar(bucket, pct, target, amt, income, higherIsBetter){
    const fill = $(bucket+'Fill');
    fill.style.width = Math.min(100, pct) + '%';
    const onTarget = higherIsBetter ? pct >= target : pct <= target;
    fill.className = 'rule-fill ' + (onTarget ? 'good' : 'bad');
    $(bucket+'Amt').textContent = `${fmt(amt)} · ${Math.round(pct)}% of income`;
  }

  function renderCategoryBudgets(){
    const exps = budgetableExpenses(expensesFor(viewYear, viewMonth));
    const spentByCat = {};
    exps.forEach(e => { spentByCat[e.category] = (spentByCat[e.category]||0) + e.amount; });

    const rows = data.categories
      .map(c => ({ c, spent: spentByCat[c.id] || 0, budget: getCategoryBudgetFor(viewYear, viewMonth, c.id) }))
      .filter(r => r.budget > 0 || r.spent > 0)
      .sort((a,b) => b.spent - a.spent);

    const listEl = $('catBudgetList');
    if(rows.length === 0){
      listEl.innerHTML = '<p class="cat-budget-empty">No category budgets set yet. Tap Edit to add some.</p>';
      return;
    }
    listEl.innerHTML = rows.map(r => {
      const hasBudget = r.budget > 0;
      const pct = hasBudget ? Math.min(100, (r.spent/r.budget)*100) : (r.spent > 0 ? 100 : 0);
      const over = hasBudget && r.spent > r.budget;
      const nums = hasBudget
        ? `<span class="${over?'over':''}">${fmt(r.spent)} / ${fmt(r.budget)}</span>`
        : `<span>${fmt(r.spent)}</span>`;
      return `
        <div class="cat-budget-row">
          <div class="cbr-head">
            <span class="cbr-name"><span class="cat-dot" style="background:${r.c.color}"></span>${r.c.label}</span>
            <span class="cbr-nums">${nums}</span>
          </div>
          <div class="cbr-bar"><div class="cbr-fill ${over?'over':''}" style="width:${pct}%;background:${r.c.color}"></div></div>
        </div>`;
    }).join('');
  }

  function totalSaved(){
    return data.expenses
      .filter(e => catInfo(e.category).bucket === 'savings')
      .reduce((s,e)=>s+e.amount, 0);
  }
  // An expense marked "Pay from: Savings" is an emergency withdrawal — it's still a real
  // expense (kept in the Expenses list for the record) but it's money already saved, not
  // money out of this month's income, so it must never count against the monthly budget,
  // category budgets, the 50/30/20 breakdown, or the projection chart.
  function isWithdrawal(e){
    return !!e && e.fundedBy === 'savings';
  }
  function budgetableExpenses(list){
    return (list || []).filter(e => !isWithdrawal(e));
  }
  function totalWithdrawnFromSavings(){
    return data.expenses.filter(isWithdrawal).reduce((s,e)=>s+e.amount, 0);
  }
  // Net contributions = money actually saved (manual + recurring) minus whatever's since
  // been pulled back out for an emergency. This is what goal progress tracks.
  function netSavingsContributed(){
    return Math.max(0, totalSaved() - totalWithdrawnFromSavings());
  }
  // Current Savings Balance = opening savings + savings added - withdrawals.
  function currentSavingsBalance(){
    const opening = Math.max(0, data.openingSavings || 0);
    const savedSince = Math.max(0, totalSaved());
    const withdrawn = Math.max(0, totalWithdrawnFromSavings());
    return Math.max(0, opening + savedSince - withdrawn);
  }
  function normalizeGoalLabel(text){
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function goalSavingsLabelMatches(entryLabel, goalName){
    const goal = normalizeGoalLabel(goalName);
    const label = normalizeGoalLabel(entryLabel);
    if(!goal || !label) return false;
    return label === goal || label.includes(goal) || goal.includes(label);
  }
  function goalLinkedSavingsTotal(){
    const goalName = data.goal ? data.goal.name : '';
    if(!goalName) return 0;
    return data.expenses
      .filter(e => catInfo(e.category).bucket === 'savings')
      .filter(e => goalSavingsLabelMatches(e.note || e.recurringLabel || '', goalName))
      .reduce((sum, e) => sum + e.amount, 0);
  }

  function renderGoal(){
    const goalEl = $('goalContent');
    const goalName = data.goal ? (data.goal.name || '') : '';
    // Goal progress is driven only by savings entries that match the goal name.
    const goalLinkedSaved = goalLinkedSavingsTotal();
    const opening = Math.max(0, data.openingSavings || 0);
    const withdrawn = Math.max(0, totalWithdrawnFromSavings());
    const goalSaved = Math.max(0, goalLinkedSaved);
    const openingRemaining = Math.max(0, opening - Math.min(withdrawn, opening));
    const totalBalance = Math.max(0, opening + goalSaved - withdrawn);
    const contributedRemaining = Math.max(0, goalSaved - Math.max(0, withdrawn - opening));
    const otherSavings = Math.max(0, currentSavingsBalance() - totalBalance);

    const openingPct = totalBalance > 0 ? (openingRemaining / totalBalance) * 100 : 0;
    const contributedPct = totalBalance > 0 ? (contributedRemaining / totalBalance) * 100 : 0;
    const balanceCaption = opening > 0
      ? `${fmt(openingRemaining)} opening savings + ${fmt(goalSaved)} matched savings for ${goalName || 'this goal'} = ${fmt(totalBalance)} total.`
      : `${fmt(goalSaved)} saved so far.`;
    const withdrawnNote = withdrawn > 0 ? ` (${fmt(withdrawn)} withdrawn for expenses is already subtracted.)` : '';
    const otherSavingsNote = otherSavings > 0
      ? `<p class="goal-caption" style="margin-top:8px;">Other savings not matched to this goal: ${fmt(otherSavings)}</p>`
      : '';

    const balanceBlock = `
      <div class="goal-head">
        <span class="goal-name">Total savings</span>
        <span class="goal-pct-badge">${fmt(totalBalance)}</span>
      </div>
      <div class="goal-bar stacked-bar">
        ${openingRemaining > 0 ? `<div class="goal-fill opening-fill" style="width:${openingPct}%"></div>` : ''}
        ${goalSaved > 0 ? `<div class="goal-fill contributed-fill" style="width:${contributedPct}%"></div>` : ''}
      </div>
      <p class="goal-caption">${balanceCaption}${withdrawnNote}</p>
      ${otherSavingsNote}
      <p class="goal-legend"><span class="legend-dot opening-fill"></span>Already saved <span class="legend-dot contributed-fill"></span>Saved since</p>
    `;

    if(!data.goal || !data.goal.target){
      goalEl.innerHTML = balanceBlock + `<p class="cat-budget-empty" style="margin-top:16px;">No goal set yet. Tap Edit to set a savings target and watch your progress toward it.</p>`;
      return;
    }

    const pct = Math.min(100, (goalSaved / data.goal.target) * 100);
    const reached = goalSaved >= data.goal.target;
    const remaining = Math.max(0, data.goal.target - goalSaved);

    goalEl.innerHTML = `
      <div class="goal-head">
        <span class="goal-name">${escapeHtml(data.goal.name || 'Savings goal')}</span>
        <span class="goal-pct-badge ${reached ? 'good' : ''}">${reached ? '🎉 reached' : Math.round(pct) + '%'}</span>
      </div>
      <div class="goal-bar"><div class="goal-fill ${reached ? 'reached' : ''}" style="width:${pct}%"></div></div>
      <p class="goal-caption">${reached
        ? `You've hit your ${fmt(data.goal.target)} goal — ${fmt(goalSaved)} matched savings toward "${escapeHtml(data.goal.name || 'this goal')}". Consider setting a new one.`
        : `${fmt(goalSaved)} matched savings so far of ${fmt(data.goal.target)} — ${fmt(remaining)} to go.`}</p>
      <hr class="goal-divider">
      ${balanceBlock}
    `;
  }
  function recurringRuleLabel(rule){
    if(rule.type === 'income') return rule.note || rule.source || 'Recurring income';
    if(rule.type === 'savings') return rule.note || 'Recurring savings';
    return rule.note || (catInfo(rule.category) || {}).label || 'Recurring expense';
  }
  function recurringTypeBadge(rule){
    if(rule.type === 'income') return 'Income';
    if(rule.type === 'savings') return 'Savings';
    return 'Expense';
  }
  function renderRecurringList(){
    const listEl = $('recurringList');
    if(!Array.isArray(data.recurring)) data.recurring = [];
    const active = data.recurring.filter(r => r && r.active !== false && ['expense','income','savings'].includes(r.type || 'expense'));

    if(active.length === 0){
      listEl.innerHTML = '<p class="cat-budget-empty">No recurring entries yet. Tap Add to create one.</p>';
      return;
    }

    listEl.innerHTML = active
      .slice()
      .sort((a,b) => (a.startDate || '').localeCompare(b.startDate || ''))
      .map(rule => {
        const next = nextRecurringDate(rule);
        const count = rule.type === 'income'
          ? data.income.filter(i => i.recurringId === rule.id).length
          : data.expenses.filter(e => e.recurringId === rule.id).length;
        const label = escapeHtml(recurringRuleLabel(rule));
        const badge = recurringTypeBadge(rule);
        const metaParts = [fmt(rule.amount), recurringFrequencyLabel(rule)];
        if(next) metaParts.push('next ' + prettyDate(next));
        if(rule.untilDate) metaParts.push('until ' + prettyDate(parseLocalDate(rule.untilDate)));
        if(count) metaParts.push(count + (count === 1 ? ' entry' : ' entries'));
        return `
          <div class="recurring-row" data-recurring-id="${rule.id}">
            <div class="recurring-main">
              <div class="recurring-name">${label}<span class="exp-badge">${badge}</span></div>
              <div class="recurring-meta">${metaParts.join(' · ')}</div>
            </div>
            <button class="exp-del" data-delete-recurring="${rule.id}" aria-label="Delete recurring entry">✕</button>
          </div>`;
      }).join('');

    listEl.querySelectorAll('[data-delete-recurring]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-delete-recurring');
        const rule = data.recurring.find(r => r.id === id);
        if(!rule) return;
        const ok = confirm(`Delete recurring ${recurringTypeBadge(rule).toLowerCase()} "${recurringRuleLabel(rule)}"? Past entries will stay in history.`);
        if(!ok) return;
        data.recurring = data.recurring.filter(r => r.id !== id);
        await saveData();
        renderAll();
      });
    });
  }

  function passesSearchFilters(entry, kind){
    const q = searchState.query.trim().toLowerCase();
    const filter = searchState.kind || 'all';
    const cat = kind === 'expense' ? catInfo(entry.category) : null;

    if(filter !== 'all'){
      if(filter === 'expense' && kind !== 'expense') return false;
      if(filter === 'income' && kind !== 'income') return false;
      if(filter === 'savings'){
        if(kind !== 'expense') return false;
        if(!cat || cat.bucket !== 'savings') return false;
      }
      if(filter === 'recurring'){
        if(kind !== 'expense' || !entry.recurringId) return false;
      }
    }

    if(!q) return true;
    const haystack = kind === 'income'
      ? [entry.source || '', 'paycheck', entry.date, entry.amount, fmt(entry.amount)].join(' ').toLowerCase()
      : [entry.note || '', cat ? cat.label : '', cat ? cat.bucket : '', entry.date, entry.amount, fmt(entry.amount), entry.recurringId ? 'recurring' : ''].join(' ').toLowerCase();
    return haystack.includes(q);
  }

  function renderExpenseList(){
    const exps = expensesFor(viewYear, viewMonth).filter(e => passesSearchFilters(e, 'expense'));
    const listEl = $('expenseList');
    const emptyEl = $('emptyState');
    const allExps = expensesFor(viewYear, viewMonth);
    if(allExps.length === 0){ listEl.innerHTML=''; emptyEl.style.display='block'; emptyEl.textContent = 'No expenses logged yet. Tap + to add one.'; return; }
    if(exps.length === 0){ listEl.innerHTML=''; emptyEl.style.display='block'; emptyEl.textContent = 'No expenses match your search or filters.'; return; }
    emptyEl.style.display = 'none';

    const groups = {};
    exps.forEach(e => { (groups[e.date] = groups[e.date]||[]).push(e); });
    const dateKeys = Object.keys(groups).sort().reverse();
    listEl.innerHTML = dateKeys.map(dateKey => {
      const d = new Date(dateKey + 'T00:00:00');
      const label = d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
      const rows = groups[dateKey].map(e => {
        const c = catInfo(e.category);
        return `
          <div class="expense-row" data-id="${e.id}">
            <span class="cat-dot" style="background:${c.color}"></span>
            <div class="exp-main">
              <div class="exp-note">${e.note ? escapeHtml(e.note) : c.label}</div>
              <div class="exp-cat">${c.label}${e.recurringId ? '<span class="exp-badge">Recurring</span>' : ''}${isWithdrawal(e) ? '<span class="exp-badge savings-badge">From savings</span>' : ''}</div>
            </div>
            <span class="exp-amt">${fmt(e.amount)}</span>
            <button class="exp-edit" data-edit-expense="${e.id}" aria-label="Edit">Edit</button>
            <button class="exp-del" data-del="${e.id}" aria-label="Delete">✕</button>
          </div>`;
      }).join('');
      return `<div class="day-group"><div class="day-label">${label}</div>${rows}</div>`;
    }).join('');

    listEl.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const item = data.expenses.find(e => e.id === btn.getAttribute('data-del'));
        markRecurringSkip(item);
        data.expenses = data.expenses.filter(e => e.id !== btn.getAttribute('data-del'));
        syncBudgetsToIncome();
        await saveData();
        renderAll();
      });
    });

    listEl.querySelectorAll('[data-edit-expense]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = data.expenses.find(e => e.id === btn.getAttribute('data-edit-expense'));
        if(item) openSheet('expense', item);
      });
    });
  }

  function renderIncomeList(){
    const incs = incomeFor(viewYear, viewMonth).filter(i => passesSearchFilters(i, 'income'));
    const listEl = $('incomeList');
    const emptyEl = $('emptyIncomeState');
    const allIncs = incomeFor(viewYear, viewMonth);
    if(allIncs.length === 0){ listEl.innerHTML=''; emptyEl.style.display='block'; emptyEl.textContent = 'No paychecks logged yet. Tap + to add one.'; return; }
    if(incs.length === 0){ listEl.innerHTML=''; emptyEl.style.display='block'; emptyEl.textContent = 'No paychecks match your search or filters.'; return; }
    emptyEl.style.display = 'none';

    const total = incs.reduce((s,i)=>s+i.amount,0);
    const rows = incs.map(i => {
      const d = new Date(i.date + 'T00:00:00');
      const label = d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
      return `
        <div class="expense-row" data-id="${i.id}">
          <span class="cat-dot" style="background:#d4a24c"></span>
          <div class="exp-main">
            <div class="exp-note">${i.source ? escapeHtml(i.source) : 'Paycheck'}</div>
            <div class="exp-cat">${label}</div>
          </div>
          <span class="exp-amt plus">+${fmt(i.amount)}</span>
          <button class="exp-edit" data-edit-income="${i.id}" aria-label="Edit">Edit</button>
          <button class="exp-del" data-delinc="${i.id}" aria-label="Delete">✕</button>
        </div>`;
    }).join('');

    listEl.innerHTML = `<div class="income-total-row"><span class="t-label">Total this month</span><span class="t-val">${fmt(total)}</span></div>${rows}`;

    listEl.querySelectorAll('[data-delinc]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const item = data.income.find(i => i.id === btn.getAttribute('data-delinc'));
        markRecurringSkip(item);
        data.income = data.income.filter(i => i.id !== btn.getAttribute('data-delinc'));
        syncBudgetsToIncome();
        await saveData();
        renderAll();
      });
    });

    listEl.querySelectorAll('[data-edit-income]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = data.income.find(i => i.id === btn.getAttribute('data-edit-income'));
        if(item) openSheet('income', item);
      });
    });
  }

  function escapeHtml(s){
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderHistory(){
    const keysWithData = new Set([
      ...Object.keys(data.budgets),
      ...data.expenses.map(e => e.date.slice(0,7)),
      ...data.income.map(i => i.date.slice(0,7))
    ]);
    const currentRealKey = monthKey(today.getFullYear(), today.getMonth());
    const keys = [...keysWithData].filter(k => k !== currentRealKey).sort().reverse();

    const listEl = $('historyList');
    if(keys.length === 0){
      listEl.innerHTML = '<p class="hist-empty">Past months will show up here once a month closes out.</p>';
      return;
    }

    listEl.innerHTML = keys.map(key => {
      const [y,m] = key.split('-').map(Number);
      const my = y, mm = m-1;
      const spent = budgetableExpenses(data.expenses.filter(e=>e.date.slice(0,7)===key)).reduce((s,e)=>s+e.amount,0);
      const income = data.income.filter(i=>i.date.slice(0,7)===key).reduce((s,i)=>s+i.amount,0);
      const budget = getBudgetFor(my, mm);
      const label = `${MONTH_NAMES[mm]} ${my}`;

      let saved, basisLabel;
      if(income > 0){
        saved = income - spent;
        basisLabel = saved >= 0
          ? `remaining ${fmt(saved)} from ${fmt(income)} income`
          : `over by ${fmt(Math.abs(saved))} against ${fmt(income)} income`;
      } else if(budget > 0){
        saved = budget - spent;
        basisLabel = saved >= 0
          ? `remaining ${fmt(saved)} from ${fmt(budget)} budget`
          : `over by ${fmt(Math.abs(saved))} against ${fmt(budget)} budget`;
      } else {
        saved = null;
        basisLabel = `remaining after expenses ${fmt(spent)}`;
      }
      const savedText = saved === null ? '—' : (saved>=0?'+':'−') + fmt(Math.abs(saved));
      const savedClass = saved === null ? '' : (saved >= 0 ? 'good' : 'bad');

      return `
        <div class="hist-row" data-jump="${key}">
          <div>
            <div class="hist-month">${label}</div>
            <div class="hist-sub">${basisLabel}</div>
          </div>
          <div class="hist-actions">
            <div class="hist-saved ${savedClass}">${savedText}</div>
            <button type="button" class="hist-edit" data-edit-month="${key}">Edit</button>
          </div>
        </div>`;
    }).join('');

    const jumpToMonth = (key) => {
      const [y,m] = key.split('-').map(Number);
      viewYear = y; viewMonth = m-1;
      setTab('expenses');
      renderAll();
    };

    listEl.querySelectorAll('[data-jump]').forEach(row => {
      row.addEventListener('click', () => jumpToMonth(row.getAttribute('data-jump')));
    });

    listEl.querySelectorAll('[data-edit-month]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToMonth(btn.getAttribute('data-edit-month'));
      });
    });
  }

  // Sums known future recurring occurrences (of the given rule types) landing after `dayOfMonth`
  // through the end of the viewed month — used so the projection isn't just linear extrapolation.
  function upcomingRecurringAmountForMonth(types, y, m, dayOfMonth, daysInMonth){
    const fromDate = parseLocalDate(toLocalISO(new Date(y, m, dayOfMonth)));
    const toDate = parseLocalDate(toLocalISO(new Date(y, m, daysInMonth)));
    let total = 0;
    (data.recurring || []).forEach(rule => {
      if(!rule || rule.active === false) return;
      const type = rule.type || 'expense';
      if(!types.includes(type)) return;
      if(type === 'expense' && rule.fundedBy === 'savings') return; // paid from savings, not the monthly budget
      total += upcomingRecurringOccurrences(rule, fromDate, toDate).length * rule.amount;
    });
    return total;
  }

  function renderChart(){
    const budget = getBudgetFor(viewYear, viewMonth);
    const daysInMonth = new Date(viewYear, viewMonth+1, 0).getDate();
    const isCurrent = (viewYear === today.getFullYear() && viewMonth === today.getMonth());
    const dayOfMonth = isCurrent ? today.getDate() : daysInMonth;
    const exps = budgetableExpenses(expensesFor(viewYear, viewMonth));

    const dailyTotals = new Array(daysInMonth+1).fill(0);
    exps.forEach(e => {
      const day = Number(e.date.slice(8,10));
      dailyTotals[day] = (dailyTotals[day]||0) + e.amount;
    });

    const actual = [];
    let running = 0;
    for(let d=1; d<=daysInMonth; d++){
      if(d <= dayOfMonth){ running += dailyTotals[d]; actual.push(running); }
      else actual.push(null);
    }

    let projected = new Array(daysInMonth).fill(null);
    let projectedTotal = actual[dayOfMonth-1] ?? 0;
    let upcomingIncome = 0;
    if(isCurrent && dayOfMonth < daysInMonth){
      const remainingDays = daysInMonth - dayOfMonth;
      const dailyRate = running / dayOfMonth;
      const linearRemaining = dailyRate * remainingDays;
      // Recurring expenses and savings due before month end are known amounts, not guesses —
      // use whichever estimate is larger so a known upcoming bill/transfer isn't underprojected.
      const upcomingSpend = upcomingRecurringAmountForMonth(['expense','savings'], viewYear, viewMonth, dayOfMonth, daysInMonth);
      upcomingIncome = upcomingRecurringAmountForMonth(['income'], viewYear, viewMonth, dayOfMonth, daysInMonth);
      const remainingEstimate = Math.max(linearRemaining, upcomingSpend);
      for(let d=dayOfMonth; d<=daysInMonth; d++){
        projected[d-1] = running + remainingEstimate * ((d - dayOfMonth) / remainingDays);
      }
      projectedTotal = running + remainingEstimate;
    }

    const budgetLine = new Array(daysInMonth).fill(budget || null);
    const labels = Array.from({length:daysInMonth}, (_,i)=>i+1);

    const badge = $('projBadge');
    const note = $('chartNote');
    const incomeNote = upcomingIncome > 0 ? ` This also accounts for ${fmt(upcomingIncome)} of recurring income still expected before month end.` : '';
    if(!isCurrent){
      badge.textContent = 'closed month';
      badge.className = 'proj-badge';
      note.textContent = `Total spend for ${MONTH_NAMES[viewMonth]}: ${fmt(actual[daysInMonth-1] || 0)}.`;
    } else if(budget === 0){
      badge.textContent = 'no budget set';
      badge.className = 'proj-badge';
      note.textContent = `At the current pace (and any recurring expenses or savings still due) you're projected to spend ${fmt(projectedTotal)} by ${MONTH_NAMES[viewMonth]} ${daysInMonth}. Set a budget to compare.${incomeNote}`;
    } else if(projectedTotal > budget){
      badge.textContent = `over by ${fmt(projectedTotal - budget)}`;
      badge.className = 'proj-badge bad';
      note.textContent = `Factoring in your pace plus any recurring expenses or savings still due, you're on track to spend ${fmt(projectedTotal)} by month end — ${fmt(projectedTotal-budget)} over your ${fmt(budget)} budget.${incomeNote}`;
    } else {
      badge.textContent = `${fmt(budget - projectedTotal)} to spare`;
      badge.className = 'proj-badge good';
      note.textContent = `Factoring in your pace plus any recurring expenses or savings still due, you're on track to spend ${fmt(projectedTotal)} by month end, staying under your ${fmt(budget)} budget.${incomeNote}`;
    }

    const ctx = $('projChart').getContext('2d');
    if(chart) chart.destroy();
    const datasets = [{
      label:'Actual', data: actual, borderColor: '#d4a24c', backgroundColor: 'rgba(212,162,76,0.12)',
      fill:true, tension:0.25, pointRadius:0, borderWidth:2.5, spanGaps:false,
    }];
    if(isCurrent && projected.some(v=>v!=null)){
      datasets.push({
        label:'Projected', data: projected,
        borderColor: projectedTotal > budget && budget>0 ? '#c1583d' : '#63ab8f',
        borderDash:[5,4], fill:false, tension:0.25, pointRadius:0, borderWidth:2, spanGaps:true,
      });
    }
    if(budget > 0){
      datasets.push({
        label:'Budget', data: budgetLine, borderColor: 'rgba(234,228,214,0.35)',
        borderDash:[2,3], fill:false, pointRadius:0, borderWidth:1.5,
      });
    }

    // Drawing the actual graph depends on the Chart.js library loading from its CDN. If that
    // ever fails (flaky connection, ad blocker, CDN outage), the numbers/badge/note above still
    // rendered correctly — only the visual line graph itself is skipped, and everything downstream
    // (like the advice tips, which need the returned projectedTotal) still runs normally.
    if(typeof Chart !== 'undefined'){
      try{
        chart = new Chart(ctx, {
          type:'line', data:{ labels, datasets },
          options:{
            responsive:true, maintainAspectRatio:false,
            interaction:{ intersect:false, mode:'index' },
            plugins:{
              legend:{ display:false },
              tooltip:{
                backgroundColor:'#212b31', titleColor:'#eae4d6', bodyColor:'#eae4d6',
                borderColor:'rgba(234,228,214,0.14)', borderWidth:1,
                callbacks:{ label: (ctx) => ctx.dataset.label + ': ' + fmt(ctx.parsed.y) }
              }
            },
            scales:{
              x:{ grid:{ color:'rgba(234,228,214,0.06)' }, ticks:{ color:'#5c6469', font:{family:'JetBrains Mono', size:9}, maxTicksLimit:8 } },
              y:{ grid:{ color:'rgba(234,228,214,0.06)' }, ticks:{ color:'#5c6469', font:{family:'JetBrains Mono', size:9}, callback:(v)=>'$'+v } }
            }
          }
        });
      }catch(err){
        console.error('Chart render failed, showing numbers without the graph.', err);
      }
    } else {
      console.error('Chart.js did not load — showing numbers without the graph.');
    }

    return { projectedTotal, budget, isCurrent };
  }

  function renderAdvice(chartInfo){
    const income = incomeFor(viewYear, viewMonth).reduce((s,i)=>s+i.amount,0);
    const budgetableExps = budgetableExpenses(expensesFor(viewYear, viewMonth));
    const spent = budgetableExps.reduce((s,e)=>s+e.amount,0);
    const totals = bucketTotals(viewYear, viewMonth);
    const budget = getBudgetFor(viewYear, viewMonth);
    const tips = [];

    if(income === 0){
      tips.push({ type:'info', text:"Log your paycheck for this month so the 50/30/20 breakdown and balance can be calculated against real income, not just your budget." });
    } else {
      const leftover = income - (totals.needs + totals.wants + totals.savings);
      const impliedSavings = totals.savings + Math.max(0, leftover);
      const needsPct = (totals.needs/income)*100;
      const wantsPct = (totals.wants/income)*100;
      const savingsPct = (impliedSavings/income)*100;

      if(leftover < 0){
        tips.push({ type:'warn', text:`You've spent ${fmt(Math.abs(leftover))} more than you've earned this month. Before anything else, pause discretionary spending and check for expenses that can wait until next paycheck.` });
      }
      if(needsPct > 50){
        tips.push({ type:'warn', text:`Needs are ${Math.round(needsPct)}% of income, above the 50% target. Housing, utilities, and transport are usually the biggest levers — worth a look if this is a repeating pattern.` });
      }
      if(wantsPct > 30){
        tips.push({ type:'warn', text:`Wants are ${Math.round(wantsPct)}% of income, above the 30% target. Try picking one category (dining out, subscriptions) to cap next month.` });
      }
      if(savingsPct < 20 && leftover >= 0){
        tips.push({ type:'warn', text:`You're saving about ${Math.round(savingsPct)}% of income, below the 20% target. Consider automating a transfer to savings right after each paycheck so it happens before spending.` });
      }
      if(needsPct <= 50 && wantsPct <= 30 && savingsPct >= 20){
        tips.push({ type:'good', text:`You're within all three 50/30/20 targets this month — solid work. This is a good month to consider increasing your savings rate or building an emergency fund.` });
      }
    }

    // Category-level advice: name the specific category that's over its budget, or — if none
    // has a budget breach — the one that's jumped the most compared to last month, so the
    // suggestion is concrete ("trim X") rather than a generic percentage.
    const catSpend = {};
    budgetableExps.forEach(e => { catSpend[e.category] = (catSpend[e.category]||0) + e.amount; });
    const prevMonth = viewMonth === 0 ? { y: viewYear-1, m: 11 } : { y: viewYear, m: viewMonth-1 };
    const prevCatSpend = {};
    budgetableExpenses(expensesFor(prevMonth.y, prevMonth.m)).forEach(e => { prevCatSpend[e.category] = (prevCatSpend[e.category]||0) + e.amount; });

    let worstOverBudget = null;
    let biggestJump = null;
    data.categories.forEach(c => {
      if(c.bucket === 'savings') return;
      const catSpent = catSpend[c.id] || 0;
      const catBudget = getCategoryBudgetFor(viewYear, viewMonth, c.id);
      if(catBudget > 0 && catSpent > catBudget){
        const over = catSpent - catBudget;
        if(!worstOverBudget || over > worstOverBudget.over) worstOverBudget = { cat: c, over, spent: catSpent, budget: catBudget };
      }
      const prevSpent = prevCatSpend[c.id] || 0;
      const diff = catSpent - prevSpent;
      if(prevSpent > 0 && diff > 30 && diff / prevSpent > 0.25){
        if(!biggestJump || diff > biggestJump.diff) biggestJump = { cat: c, diff, spent: catSpent, prev: prevSpent };
      }
    });
    if(worstOverBudget){
      tips.push({ type:'warn', text:`You've spent ${fmt(worstOverBudget.spent)} on ${worstOverBudget.cat.label} this month — ${fmt(worstOverBudget.over)} over its ${fmt(worstOverBudget.budget)} budget. Try trimming this category next month.` });
    } else if(biggestJump){
      tips.push({ type:'warn', text:`${biggestJump.cat.label} spending is up ${fmt(biggestJump.diff)} from last month (${fmt(biggestJump.prev)} → ${fmt(biggestJump.spent)}). Worth reining in next month if it wasn't a one-off.` });
    }

    // Surplus advice: when spending is comfortably under budget/income, suggest putting the
    // extra to work in savings rather than letting it just roll into next month's spending.
    if(income > 0){
      const surplus = income - spent;
      const surplusPct = (surplus / income) * 100;
      if(surplus > 0 && surplusPct >= 25){
        const goalNote = data.goal && data.goal.target ? ` toward your "${data.goal.name || 'savings'}" goal` : '';
        tips.push({ type:'good', text:`You've only spent ${Math.round((spent/income)*100)}% of this month's income so far, leaving ${fmt(surplus)} unallocated. Consider moving some of it into savings${goalNote} before it gets absorbed into next month's spending.` });
      }
    } else if(budget > 0 && spent < budget * 0.5){
      tips.push({ type:'good', text:`You've used less than half your ${fmt(budget)} budget so far this month. If that holds, this could be a good month to put the difference toward savings.` });
    }

    if(chartInfo && chartInfo.isCurrent && chartInfo.budget > 0 && chartInfo.projectedTotal > chartInfo.budget){
      tips.push({ type:'warn', text:`Your projected month-end spending (${fmt(chartInfo.projectedTotal)}) is on track to exceed your budget. Slowing your pace now is easier than catching up in the final week.` });
    }

    if(data.goal && data.goal.target){
      const saved = currentSavingsBalance();
      const pct = (saved / data.goal.target) * 100;
      if(saved >= data.goal.target){
        tips.push({ type:'good', text:`You've reached your "${data.goal.name || 'savings'}" goal of ${fmt(data.goal.target)} — nice work. Consider setting a new target to keep the momentum going.` });
      } else if(pct >= 75){
        tips.push({ type:'good', text:`You're ${Math.round(pct)}% of the way to your "${data.goal.name || 'savings'}" goal — only ${fmt(data.goal.target-saved)} left to go.` });
      } else {
        tips.push({ type:'info', text:`You're ${Math.round(pct)}% of the way to your "${data.goal.name || 'savings'}" goal (${fmt(saved)} of ${fmt(data.goal.target)}).` });
      }
    }

    if(tips.length === 0){
      tips.push({ type:'info', text:"Keep logging expenses and paychecks daily — the more consistent the data, the more useful these projections and tips become." });
    }

    const shown = tips.slice(0,4);
    $('adviceList').innerHTML = shown.map(t => `<li><span class="mark">—</span><span>${t.text}</span></li>`).join('');
  }

  function renderAll(){
    // Each section renders independently — if one throws (e.g. the Chart.js CDN script
    // failed to load), it's logged and skipped, but it can never take the rest of the
    // dashboard down with it. Advice previously went silently blank whenever the chart
    // failed for any reason, since it ran right after it with nothing catching the error.
    const steps = [
      ['header', renderHeader],
      ['summary', renderSummary],
      ['rule', renderRule],
      ['categoryBudgets', renderCategoryBudgets],
      ['goal', renderGoal],
      ['recurringList', renderRecurringList],
      ['expenseList', renderExpenseList],
      ['incomeList', renderIncomeList],
      ['history', renderHistory],
    ];
    steps.forEach(([label, fn]) => {
      try { fn(); } catch(err){ console.error(`renderAll: ${label} failed`, err); }
    });

    let chartInfo = null;
    try { chartInfo = renderChart(); } catch(err){ console.error('renderAll: chart failed', err); }
    try { renderAdvice(chartInfo); } catch(err){ console.error('renderAll: advice failed', err); }
  }

  function setTab(tab){
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===tab));
    $('expensesPane').classList.toggle('active', tab==='expenses');
    $('incomePane').classList.toggle('active', tab==='income');
    $('historyPane').classList.toggle('active', tab==='history');
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

  $('searchInput').addEventListener('input', (e) => { searchState.query = e.target.value || ''; renderAll(); });
  $('kindFilter').addEventListener('change', (e) => { searchState.kind = e.target.value || 'all'; renderAll(); });
  $('clearSearchBtn').addEventListener('click', () => { searchState.query = ''; searchState.kind = 'all'; $('searchInput').value = ''; $('kindFilter').value = 'all'; renderAll(); });

  $('prevMonth').addEventListener('click', () => { viewMonth--; if(viewMonth<0){viewMonth=11; viewYear--;} renderAll(); });
  $('nextMonth').addEventListener('click', () => { viewMonth++; if(viewMonth>11){viewMonth=0; viewYear++;} renderAll(); });

  // Recurring is available for expense, income, and savings entries. It's shown whenever
  // adding a brand-new entry, or when editing an entry that already belongs to a recurring rule
  // (so its schedule can be updated in place rather than only its one-off amount/date).
  function recurringBlockVisible(){
    if(!editingEntry) return true;
    return !!editingEntry.recurringId;
  }
  function updateFundingVisibility(){
    const isSavingsCategory = entryMode === 'expense' && $('inpCategory').value === 'savings';
    const show = entryMode === 'expense' && !isSavingsCategory;
    $('fundingField').style.display = show ? 'block' : 'none';
    if(!show) setFundingChoice('budget');
  }
  function setFundingChoice(choice){
    $('fundingToggle').querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-fund') === choice);
    });
    $('fundingNote').style.display = choice === 'savings' ? 'block' : 'none';
  }
  function getFundingChoice(){
    const active = $('fundingToggle').querySelector('button.active');
    return active ? active.getAttribute('data-fund') : 'budget';
  }
  $('fundingToggle').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => setFundingChoice(btn.getAttribute('data-fund')));
  });
  $('inpCategory').addEventListener('change', updateFundingVisibility);

  function setEntryMode(mode){
    entryMode = mode;
    $('toggleExpense').classList.toggle('active', mode==='expense');
    $('toggleIncome').classList.toggle('active', mode==='income');
    $('toggleSavings').classList.toggle('active', mode==='savings');
    $('categoryField').style.display = mode==='expense' ? 'block' : 'none';
    $('noteField').style.display = mode==='expense' ? 'block' : 'none';
    $('sourceField').style.display = mode==='income' ? 'block' : 'none';
    $('savingsNoteField').style.display = mode==='savings' ? 'block' : 'none';
    $('recurringBlock').style.display = recurringBlockVisible() ? 'block' : 'none';
    updateFundingVisibility();
  }
  // ---------- weekday picker (for "every Monday", "every Saturday", or all week) ----------
  function updateWeekdayPickerVisibility(){
    const isWeekly = $('inpRepeatUnit').value === 'weeks';
    $('weekdayPickerField').style.display = isWeekly ? 'block' : 'none';
    if(!isWeekly){
      setWeekdayPicker([]);
    }
  }
  $('weekdayPicker').querySelectorAll('button[data-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = Number(btn.getAttribute('data-day'));
      btn.classList.toggle('active');
      if(getWeekdayPickerSelection().length === 0){
        setWeekdayPicker([day]);
      } else {
        setWeekdayPicker(getWeekdayPickerSelection());
      }
    });
  });
  $('weekdayAllBtn').addEventListener('click', () => {
    const selected = getWeekdayPickerSelection();
    if(selected.length === 7){
      const ref = parseLocalDate($('inpDate').value) || parseLocalDate(toLocalISO(new Date()));
      setWeekdayPicker([ref ? ref.getDay() : 1]);
      return;
    }
    setWeekdayPicker([0,1,2,3,4,5,6]);
  });
  $('inpRepeatUnit').addEventListener('change', () => {
    updateWeekdayPickerVisibility();
    if($('inpRepeatUnit').value === 'weeks' && getWeekdayPickerSelection().length === 0){
      const ref = parseLocalDate($('inpDate').value) || parseLocalDate(toLocalISO(new Date()));
      setWeekdayPicker([ref ? ref.getDay() : 1]);
    }
  });
  $('inpDate').addEventListener('change', () => {
    if($('inpRepeatUnit').value === 'weeks' && getWeekdayPickerSelection().length === 0){
      const ref = parseLocalDate($('inpDate').value) || parseLocalDate(toLocalISO(new Date()));
      setWeekdayPicker([ref ? ref.getDay() : 1]);
    }
  });

  $('toggleExpense').addEventListener('click', () => setEntryMode('expense'));
  $('toggleIncome').addEventListener('click', () => setEntryMode('income'));
  $('toggleSavings').addEventListener('click', () => setEntryMode('savings'));
  $('inpRecurringToggle').addEventListener('change', () => {
    $('recurringFields').style.display = $('inpRecurringToggle').checked ? 'grid' : 'none';
    updateWeekdayPickerVisibility();
    if($('inpRecurringToggle').checked && $('inpRepeatUnit').value === 'weeks' && getWeekdayPickerSelection().length === 0){
      const ref = parseLocalDate($('inpDate').value) || parseLocalDate(toLocalISO(new Date()));
      setWeekdayPicker([ref ? ref.getDay() : 1]);
    }
  });

  function setSheetTitle(){
    $('sheet').querySelector('h3').textContent = editingEntry ? 'Edit entry' : 'Add entry';
    $('saveBtn').textContent = editingEntry ? 'Update' : 'Save';
  }

  function openSheet(mode, entry=null, opts={}){
    editingEntry = entry ? { type: mode, id: entry.id, recurringId: entry.recurringId || null } : null;
    setEntryMode(mode || 'expense');
    setSheetTitle();
    $('inpAmount').value = entry ? entry.amount : '';
    $('inpNote').value = entry && entry.note ? entry.note : '';
    $('inpSource').value = entry && entry.source ? entry.source : '';
    $('inpSavingsNote').value = entry && entry.note ? entry.note : '';
    $('inpCategory').value = entry && entry.category ? entry.category : 'food';
    setFundingChoice(entry && entry.fundedBy === 'savings' ? 'savings' : 'budget');
    updateFundingVisibility();
    const baseDate = entry && entry.date ? entry.date : new Date(viewYear, viewMonth, Math.min(today.getDate(), new Date(viewYear,viewMonth+1,0).getDate())).toISOString().slice(0,10);
    $('inpDate').value = baseDate;

    const linkedRule = entry && entry.recurringId ? data.recurring.find(r => r.id === entry.recurringId) : null;
    const startNewRecurring = !entry && !!opts.recurring;
    $('inpRecurringToggle').checked = !!linkedRule || startNewRecurring;
    $('inpRecurringToggle').disabled = !!linkedRule; // editing: schedule can change, but can't detach here
    const repeat = linkedRule ? ruleRepeat(linkedRule) : { interval: opts.repeatInterval || 1, unit: opts.repeatUnit || 'months' };
    $('inpRepeatInterval').value = repeat.interval;
    $('inpRepeatUnit').value = repeat.unit;
    $('inpRecurringUntil').value = linkedRule ? (linkedRule.untilDate || '') : (opts.untilDate || '');
    $('recurringNote').textContent = linkedRule
      ? 'Editing this updates the recurring rule itself — future occurrences will follow the new schedule.'
      : "The first entry is saved now. Future ones appear automatically when the app opens.";
    $('recurringFields').style.display = $('inpRecurringToggle').checked ? 'grid' : 'none';
    updateWeekdayPickerVisibility();
    if(repeat.unit === 'weeks'){
      const ref = parseLocalDate(baseDate) || parseLocalDate(toLocalISO(new Date()));
      setWeekdayPicker(linkedRule ? normalizeWeekDays(linkedRule) : [ref ? ref.getDay() : 1]);
    } else {
      setWeekdayPicker([]);
    }
    $('sheet').classList.add('open');
  }
  function closeSheet(){
    $('sheet').classList.remove('open');
    editingEntry = null;
    $('inpRecurringToggle').checked = false;
    $('inpRecurringToggle').disabled = false;
    $('inpRecurringUntil').value = '';
    $('inpRepeatInterval').value = 1;
    $('inpRepeatUnit').value = 'months';
    $('recurringFields').style.display = 'none';
    updateWeekdayPickerVisibility();
    setWeekdayPicker([]);
    setFundingChoice('budget');
    setSheetTitle();
  }

  $('addBtn').addEventListener('click', () => openSheet('expense'));
  $('addRecurringBtn').addEventListener('click', () => openSheet('expense', null, { recurring: true }));
  $('cancelBtn').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', e => { if(e.target.id==='sheet') closeSheet(); });

  $('saveBtn').addEventListener('click', async () => {
    const amount = parseFloat($('inpAmount').value);
    if(!amount || amount <= 0){ $('inpAmount').focus(); return; }
    const date = $('inpDate').value || new Date().toISOString().slice(0,10);
    const [y,m] = date.split('-').map(Number);

    const updatingRecurringRule = !!(editingEntry && editingEntry.recurringId);
    const creatingRecurring = !editingEntry && $('inpRecurringToggle').checked;
    const touchesRecurring = updatingRecurringRule || creatingRecurring;
    const repeatInterval = Math.max(1, parseInt($('inpRepeatInterval').value, 10) || 1);
    const repeatUnit = REPEAT_UNITS.includes($('inpRepeatUnit').value) ? $('inpRepeatUnit').value : 'months';
    const untilDate = $('inpRecurringUntil').value || '';
    const selectedWeekDays = repeatUnit === 'weeks'
      ? (getWeekdayPickerSelection().length ? getWeekdayPickerSelection() : [parseLocalDate(date)?.getDay() ?? new Date(date + 'T12:00:00').getDay()])
      : [];

    if(touchesRecurring && untilDate && untilDate < date){
      $('inpRecurringUntil').focus();
      alert('Repeat until must be on or after the start date.');
      return;
    }

    // Savings contributions (category 'savings') are never "withdrawals" — the funding
    // toggle only applies to real expenses paid from either the monthly budget or savings.
    function resolveFundedBy(category){
      if(category === 'savings') return 'budget';
      return getFundingChoice() === 'savings' ? 'savings' : 'budget';
    }

    if(editingEntry){
      if(editingEntry.type === 'expense'){
        const item = data.expenses.find(e => e.id === editingEntry.id);
        if(item){
          const category = $('inpCategory').value;
          item.amount = amount;
          item.category = category;
          item.note = $('inpNote').value.trim();
          item.date = date;
          item.fundedBy = resolveFundedBy(category);
        }
      } else if(editingEntry.type === 'income'){
        const item = data.income.find(i => i.id === editingEntry.id);
        if(item){
          item.amount = amount;
          item.source = $('inpSource').value.trim();
          item.date = date;
        }
      } else {
        const item = data.expenses.find(e => e.id === editingEntry.id);
        if(item){
          item.amount = amount;
          item.category = 'savings';
          item.note = $('inpSavingsNote').value.trim();
          item.date = date;
        }
      }

      if(updatingRecurringRule){
        const rule = data.recurring.find(r => r.id === editingEntry.recurringId);
        if(rule){
          rule.amount = amount;
          rule.repeatInterval = repeatInterval;
          rule.repeatUnit = repeatUnit;
          rule.untilDate = untilDate;
          if(repeatUnit === 'weeks') rule.weekDays = selectedWeekDays;
          else delete rule.weekDays;
          if(editingEntry.type === 'expense') rule.category = $('inpCategory').value;
          if(editingEntry.type === 'expense') rule.note = $('inpNote').value.trim();
          if(editingEntry.type === 'expense') rule.fundedBy = resolveFundedBy(rule.category);
          if(editingEntry.type === 'income') rule.note = $('inpSource').value.trim();
          if(editingEntry.type === 'savings') rule.note = $('inpSavingsNote').value.trim();
        }
      }
    } else if(entryMode === 'expense'){
      const category = $('inpCategory').value;
      const note = $('inpNote').value.trim();
      const fundedBy = resolveFundedBy(category);
      if(creatingRecurring){
        const ruleId = 'r' + Date.now() + Math.random().toString(36).slice(2,7);
        const rule = { id: ruleId, type: 'expense', amount, category, note, fundedBy, startDate: date, repeatInterval, repeatUnit, untilDate, active: true };
        if(repeatUnit === 'weeks') rule.weekDays = selectedWeekDays;
        data.recurring.push(rule);
        data.expenses.push({ id: 'e'+Date.now()+Math.random().toString(36).slice(2,7), amount, category, note, fundedBy, date, recurringId: ruleId, recurringDate: date, recurringLabel: recurringFrequencyLabel(rule) });
      } else {
        data.expenses.push({ id: 'e'+Date.now()+Math.random().toString(36).slice(2,7), amount, category, note, fundedBy, date });
      }
    } else if(entryMode === 'income'){
      const source = $('inpSource').value.trim();
      if(creatingRecurring){
        const ruleId = 'r' + Date.now() + Math.random().toString(36).slice(2,7);
        const rule = { id: ruleId, type: 'income', amount, note: source, startDate: date, repeatInterval, repeatUnit, untilDate, active: true };
        if(repeatUnit === 'weeks') rule.weekDays = selectedWeekDays;
        data.recurring.push(rule);
        data.income.push({ id: 'i'+Date.now()+Math.random().toString(36).slice(2,7), amount, source, date, recurringId: ruleId, recurringDate: date, recurringLabel: recurringFrequencyLabel(rule) });
      } else {
        data.income.push({ id: 'i'+Date.now()+Math.random().toString(36).slice(2,7), amount, source, date });
      }
    } else {
      const note = $('inpSavingsNote').value.trim();
      if(creatingRecurring){
        const ruleId = 'r' + Date.now() + Math.random().toString(36).slice(2,7);
        const rule = { id: ruleId, type: 'savings', amount, note, startDate: date, repeatInterval, repeatUnit, untilDate, active: true };
        if(repeatUnit === 'weeks') rule.weekDays = selectedWeekDays;
        data.recurring.push(rule);
        data.expenses.push({ id: 'e'+Date.now()+Math.random().toString(36).slice(2,7), amount, category:'savings', note, date, recurringId: ruleId, recurringDate: date, recurringLabel: recurringFrequencyLabel(rule) });
      } else {
        data.expenses.push({ id: 'e'+Date.now()+Math.random().toString(36).slice(2,7), amount, category:'savings', note, date });
      }
    }

    syncBudgetsToIncome();
    await saveData();
    closeSheet();
    viewYear = y; viewMonth = m-1;
    renderAll();
  });

  function closeBudgetSheet(){ $('budgetSheet').classList.remove('open'); }

  // ---------- category budgets / manage categories ----------
  function renderManageCatList(){
    const usageCount = {};
    data.expenses.forEach(e => { usageCount[e.category] = (usageCount[e.category]||0) + 1; });

    $('manageCatList').innerHTML = data.categories.map(c => {
      const budget = getCategoryBudgetFor(viewYear, viewMonth, c.id);
      const count = usageCount[c.id] || 0;
      const usageSuffix = count > 0 ? ` · used ${count}×` : '';
      const isSavingsCat = c.id === 'savings';
      const bucketControl = isSavingsCat
        ? `<span class="manage-cat-bucket">savings (fixed)</span>`
        : `<select class="manage-cat-bucket-select" data-bucket-for="${c.id}">
            <option value="needs" ${c.bucket==='needs'?'selected':''}>needs</option>
            <option value="wants" ${c.bucket==='wants'?'selected':''}>wants</option>
            <option value="savings" ${c.bucket==='savings'?'selected':''}>savings</option>
          </select>`;
      return `
        <div class="manage-row" data-cat="${c.id}">
          <div class="manage-cat-info">
            <span class="cat-dot" style="background:${c.color}"></span>
            <div style="min-width:0;flex:1;">
              <input type="text" class="manage-cat-name-input" data-name-for="${c.id}" value="${escapeHtml(c.label)}">
              <div class="manage-cat-bucket-row">${bucketControl}<span class="manage-cat-bucket">${usageSuffix}</span></div>
            </div>
          </div>
          <input type="number" class="manage-budget-input" inputmode="decimal" step="0.01" min="0"
            placeholder="0.00" data-budget-for="${c.id}" value="${budget ? budget : ''}">
          <button type="button" class="manage-del" data-remove-cat="${c.id}" title="Delete category">✕</button>
        </div>`;
    }).join('');

    $('manageCatList').querySelectorAll('[data-remove-cat]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-remove-cat');
        const cat = data.categories.find(c => c.id === id);
        if(!cat) return;

        if(data.categories.length <= 1){
          alert("You need at least one category — add another before removing this one.");
          return;
        }

        const count = usageCount[id] || 0;
        if(count > 0){
          const fallback = data.categories.find(c => c.id === 'other' && c.id !== id)
            || data.categories.find(c => c.id !== id);
          const ok = confirm(`Delete "${cat.label}"? ${count} expense${count>1?'s':''} logged under it will be moved to "${fallback.label}".`);
          if(!ok) return;
          data.expenses.forEach(e => { if(e.category === id) e.category = fallback.id; });
          data.recurring.forEach(r => { if(r.category === id) r.category = fallback.id; });
        }

        data.categories = data.categories.filter(c => c.id !== id);
        Object.keys(data.categoryBudgets).forEach(k => { if(data.categoryBudgets[k]) delete data.categoryBudgets[k][id]; });

        await saveData();
        populateCategorySelect();
        renderManageCatList();
        renderAll();
      });
    });
  }

  function openCatBudgetSheet(){
    $('catBudgetMonthLabel').textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;
    $('inpNewCatName').value = '';
    $('inpNewCatBucket').value = 'wants';
    $('catNameTaken').style.display = 'none';
    renderManageCatList();
    $('catBudgetSheet').classList.add('open');
  }
  function closeCatBudgetSheet(){ $('catBudgetSheet').classList.remove('open'); }
  $('manageCatBtn').addEventListener('click', openCatBudgetSheet);
  $('catBudgetCancelBtn').addEventListener('click', closeCatBudgetSheet);
  $('catBudgetSheet').addEventListener('click', e => { if(e.target.id==='catBudgetSheet') closeCatBudgetSheet(); });

  $('addCatBtn').addEventListener('click', async () => {
    const name = $('inpNewCatName').value.trim();
    if(!name) { $('inpNewCatName').focus(); return; }
    const taken = data.categories.some(c => c.label.toLowerCase() === name.toLowerCase());
    if(taken){ $('catNameTaken').style.display = 'block'; return; }
    $('catNameTaken').style.display = 'none';

    const bucket = $('inpNewCatBucket').value;
    const newCat = { id: slugify(name), label: name, color: nextCategoryColor(), bucket };
    data.categories.push(newCat);
    $('inpNewCatName').value = '';
    await saveData();
    renderManageCatList();
    populateCategorySelect();
  });

  $('catBudgetSaveBtn').addEventListener('click', async () => {
    // Validate name edits first — every non-blank name must stay unique (case-insensitive).
    const nameInputs = Array.from($('manageCatList').querySelectorAll('[data-name-for]'));
    const seenNames = new Set();
    for(const input of nameInputs){
      const id = input.getAttribute('data-name-for');
      const trimmed = input.value.trim();
      const original = data.categories.find(c => c.id === id);
      const finalName = trimmed || (original ? original.label : '');
      const key = finalName.toLowerCase();
      if(seenNames.has(key)){
        alert(`Two categories can't both be named "${finalName}". Please make them unique before saving.`);
        input.focus();
        return;
      }
      seenNames.add(key);
    }

    nameInputs.forEach(input => {
      const id = input.getAttribute('data-name-for');
      const cat = data.categories.find(c => c.id === id);
      if(!cat) return;
      const trimmed = input.value.trim();
      if(trimmed) cat.label = trimmed;
    });
    $('manageCatList').querySelectorAll('[data-bucket-for]').forEach(sel => {
      const id = sel.getAttribute('data-bucket-for');
      const cat = data.categories.find(c => c.id === id);
      if(cat && cat.id !== 'savings') cat.bucket = sel.value; // savings category's bucket stays fixed
    });

    const key = monthKey(viewYear, viewMonth);
    const entries = {};
    $('manageCatList').querySelectorAll('[data-budget-for]').forEach(input => {
      const val = parseFloat(input.value);
      if(!isNaN(val) && val > 0) entries[input.getAttribute('data-budget-for')] = val;
    });
    data.categoryBudgets[key] = entries;
    await saveData();
    closeCatBudgetSheet();
    populateCategorySelect();
    renderAll();
  });

  // ---------- savings goal ----------
  function setGoalSheetMode(mode){
    goalSheetMode = mode === 'goal' ? 'goal' : 'opening';
    $('goalChoiceToggle').querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-goal-mode') === goalSheetMode);
    });
    $('goalFields').style.display = goalSheetMode === 'goal' ? 'block' : 'none';
    $('openingSavingsFields').style.display = goalSheetMode === 'opening' ? 'block' : 'none';
  }
  function openGoalSheet(){
    setGoalSheetMode(data.goal && data.goal.target ? 'goal' : 'opening');
    $('inpGoalName').value = data.goal ? (data.goal.name || '') : '';
    $('inpGoalTarget').value = data.goal ? (data.goal.target || '') : '';
    $('inpOpeningSavings').value = '';
    $('openingSavingsNote').textContent = `Current saved amount: ${fmt(data.openingSavings || 0)}. Enter any extra money here and it will be added to your opening balance only.`;
    $('goalSheet').classList.add('open');
  }
  function closeGoalSheet(){ $('goalSheet').classList.remove('open'); }
  $('goalChoiceToggle').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => setGoalSheetMode(btn.getAttribute('data-goal-mode')));
  });
  $('editGoalBtn').addEventListener('click', openGoalSheet);
  $('goalCancelBtn').addEventListener('click', closeGoalSheet);
  $('goalSheet').addEventListener('click', e => { if(e.target.id==='goalSheet') closeGoalSheet(); });

  $('goalSaveBtn').addEventListener('click', async () => {
    if(goalSheetMode === 'opening'){
      const openingRaw = parseFloat($('inpOpeningSavings').value);
      if(!isNaN(openingRaw) && openingRaw >= 0){
        data.openingSavings = (data.openingSavings || 0) + openingRaw;
      }
    } else {
      const name = $('inpGoalName').value.trim();
      const targetRaw = $('inpGoalTarget').value.trim();
      if(targetRaw !== ''){
        const target = parseFloat(targetRaw);
        if(!target || target <= 0){ $('inpGoalTarget').focus(); return; }
        data.goal = { name, target };
      }
    }
    await saveData();
    closeGoalSheet();
    renderAll();
  });

  $('goalClearBtn').addEventListener('click', async () => {
    data.goal = null;
    await saveData();
    closeGoalSheet();
    renderAll();
  });

  // ---------- background scroll lock ----------
  // Any bottom sheet (Add Entry, Budget, Savings Goal, Category Budget) opening/closing
  // toggles the 'open' class on its .sheet-overlay — watch all of them generically so the
  // page behind the modal never scrolls, no matter which sheet triggered it.
  // Plain `overflow:hidden` on body isn't reliably honored on mobile Safari/Chrome once
  // the finger is already touching the screen (rubber-band/elastic scroll can still creep
  // through), so the body is pinned with position:fixed while a sheet is open, then restored
  // to its exact prior scroll position when the last sheet closes.
  (function initScrollLock(){
    const overlays = document.querySelectorAll('.sheet-overlay');
    let isLocked = false;
    let savedScrollY = 0;
    function updateScrollLock(){
      const anyOpen = Array.from(overlays).some(el => el.classList.contains('open'));
      if(anyOpen && !isLocked){
        savedScrollY = window.scrollY || window.pageYOffset || 0;
        document.documentElement.classList.add('scroll-locked');
        document.body.classList.add('scroll-locked');
        document.body.style.position = 'fixed';
        document.body.style.top = `-${savedScrollY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.width = '100%';
        isLocked = true;
      } else if(!anyOpen && isLocked){
        document.documentElement.classList.remove('scroll-locked');
        document.body.classList.remove('scroll-locked');
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.width = '';
        window.scrollTo(0, savedScrollY);
        isLocked = false;
      }
    }
    overlays.forEach(el => {
      new MutationObserver(updateScrollLock).observe(el, { attributes:true, attributeFilter:['class'] });
    });
    updateScrollLock();
  })();

  async function init(){
    populateCategorySelect();
    const failsafe = setTimeout(() => {
      $('loadingState').style.display = 'none';
      $('mainContent').style.display = 'block';
    }, 4000);
    try{
      await loadData();
      materializeRecurringEntries();
      syncBudgetsToIncome();
      await saveData();
    }catch(e){
      console.log('Load failed unexpectedly, starting fresh.', e);
    }
    clearTimeout(failsafe);
    populateCategorySelect();
    $('searchInput').value = searchState.query;
    $('kindFilter').value = searchState.kind;
    $('loadingState').style.display = 'none';
    $('mainContent').style.display = 'block';
    renderAll();
  }
  init();
})();
