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

  let data = { budgets:{}, categoryBudgets:{}, categories: DEFAULT_CATS.map(c=>({...c})), goal:null, goals:[], expenses:[], income:[], recurring:[] };
  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let chart = null;
  let categoryChart = null;
  let entryMode = 'expense'; // or 'income'
  let editingId = null;
  let editingGoalId = null;
  let searchState = { query:'', category:'all', type:'all' };

  const $ = id => document.getElementById(id);
  const fmt = n => '$' + (Math.round(n*100)/100).toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2});
  const monthKey = (y,m) => `${y}-${String(m+1).padStart(2,'0')}`;
  const catInfo = id => data.categories.find(c=>c.id===id) || data.categories[data.categories.length-1];

  const goalList = () => Array.isArray(data.goals) ? data.goals : [];
  const syncPrimaryGoal = () => { data.goal = goalList()[0] || null; };
  const goalLabel = (goalId) => {
    if(!goalId) return 'General savings';
    const g = goalList().find(x => x.id === goalId);
    return g ? g.name : 'General savings';
  };
  const safeGoalId = (goalId) => (goalId && goalList().some(g => g.id === goalId) ? goalId : '');

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
    const legacyGoal = (parsed && parsed.goal && parsed.goal.target)
      ? [{ id: 'goal-legacy', name: parsed.goal.name || 'Savings goal', target: parsed.goal.target }]
      : [];
    const goals = (parsed && Array.isArray(parsed.goals)) ? parsed.goals : legacyGoal;
    return {
      budgets: (parsed && parsed.budgets) || {},
      categoryBudgets: (parsed && parsed.categoryBudgets) || {},
      categories,
      goal: (goals && goals[0]) || null,
      goals,
      expenses: (parsed && parsed.expenses) || [],
      income: (parsed && parsed.income) || [],
      recurring: (parsed && Array.isArray(parsed.recurring)) ? parsed.recurring : []
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
    const priorKeys = Object.keys(data.budgets).filter(k => k < key).sort();
    if(priorKeys.length) return data.budgets[priorKeys[priorKeys.length-1]];
    return 0;
  }

  // Keeps the monthly budget in sync with logged paychecks: the budget for a
  // given month always tracks that month's total income.
  function syncBudgetToIncome(y,m){
    const total = incomeFor(y,m).reduce((s,i)=>s+i.amount, 0);
    data.budgets[monthKey(y,m)] = total;
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
  function parseDateYMD(value){
    return value ? new Date(value + 'T00:00:00') : null;
  }
  function formatDateYMD(date){
    return date.toISOString().slice(0,10);
  }
  function monthStart(y,m){ return new Date(y,m,1); }
  function monthEnd(y,m){ return new Date(y,m+1,0); }
  function addRecurrenceStep(date, frequency){
    const d = new Date(date);
    if(frequency === 'weekly') d.setDate(d.getDate() + 7);
    else if(frequency === 'biweekly') d.setDate(d.getDate() + 14);
    else if(frequency === 'quarterly') d.setMonth(d.getMonth() + 3);
    else if(frequency === 'yearly') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1); // monthly default
    return d;
  }
  function isSameMonth(date, y, m){
    return date.getFullYear() === y && date.getMonth() === m;
  }
  function txnSearchText(txn, isIncome=false){
    const c = isIncome ? null : catInfo(txn.category);
    return [
      txn.note || '',
      txn.source || '',
      txn.category || '',
      c ? c.label : '',
      txn.date || '',
      txn.amount != null ? String(txn.amount) : ''
    ].join(' ').toLowerCase();
  }
  function matchesSearch(txn, isIncome=false){
    const q = searchState.query.trim().toLowerCase();
    if(!q) return true;
    return txnSearchText(txn, isIncome).includes(q);
  }
  function matchesCategory(txn){
    const cat = searchState.category;
    if(cat === 'all') return true;
    return txn.category === cat || (catInfo(txn.category) && catInfo(txn.category).bucket === cat);
  }
  function matchesType(txn, kind){
    const t = searchState.type;
    if(t === 'all') return true;
    if(t === 'expense') return kind === 'expense';
    if(t === 'income') return kind === 'income';
    if(t === 'savings') return kind === 'expense' && txn.category === 'savings';
    return true;
  }
  function filteredExpensesFor(y,m){
    return expensesFor(y,m).filter(e => matchesSearch(e) && matchesCategory(e) && matchesType(e, 'expense'));
  }
  function filteredIncomeFor(y,m){
    return incomeFor(y,m).filter(i => matchesSearch(i, true) && matchesType(i, 'income'));
  }
  function recurringMatchesType(template){
    return searchState.type === 'all'
      || (searchState.type === 'expense' && template.type === 'expense')
      || (searchState.type === 'income' && template.type === 'income')
      || (searchState.type === 'savings' && template.type === 'expense' && template.category === 'savings');
  }
  function getRecurringLabel(template){
    if(template.type === 'income') return template.source || 'Paycheck';
    return catInfo(template.category).label || template.note || 'Expense';
  }
  function recurrenceFrequencyLabel(freq){
    return ({
      weekly:'Weekly',
      biweekly:'Every 2 weeks',
      monthly:'Monthly',
      quarterly:'Quarterly',
      yearly:'Yearly'
    })[freq] || 'Monthly';
  }
  function cloneEntry(entry){
    return JSON.parse(JSON.stringify(entry));
  }
  function updateSearchSummary(){
    const exp = filteredExpensesFor(viewYear, viewMonth).length;
    const inc = filteredIncomeFor(viewYear, viewMonth).length;
    $('searchCount').textContent = `${exp + inc} results`;
  }
  function materializeRecurringForMonth(y, m){
    if(!Array.isArray(data.recurring) || !data.recurring.length) return false;
    let changed = false;
    const start = monthStart(y,m);
    const end = monthEnd(y,m);
    const existingExpenseKey = (templateId, date) => `${templateId}|${date}|expense`;
    const existingIncomeKey = (templateId, date) => `${templateId}|${date}|income`;
    for(const template of data.recurring){
      if(!template || !template.active) continue;
      const templateStart = parseDateYMD(template.startDate || template.date || formatDateYMD(start));
      if(!templateStart) continue;
      const templateEnd = template.endDate ? parseDateYMD(template.endDate) : null;
      let d = new Date(templateStart);
      while(d <= end){
        if(templateEnd && d > templateEnd) break;
        if(d >= start && d <= end){
          const date = formatDateYMD(d);
          if(template.type === 'income'){
            if(!data.income.some(i => i.recurringId === template.id && i.date === date)){
              data.income.push({
                id: 'i' + Date.now() + Math.random().toString(36).slice(2,7),
                amount: Number(template.amount) || 0,
                source: template.source || 'Paycheck',
                date,
                recurringId: template.id
              });
              changed = true;
            }
          } else {
            if(!data.expenses.some(e => e.recurringId === template.id && e.date === date)){
              data.expenses.push({
                id: 'e' + Date.now() + Math.random().toString(36).slice(2,7),
                amount: Number(template.amount) || 0,
                category: template.category || 'other',
                note: template.note || '',
                date,
                recurringId: template.id
              });
              changed = true;
            }
          }
        }
        d = addRecurrenceStep(d, template.frequency || 'monthly');
      }
    }
    if(changed){
      syncBudgetToIncome(y, m);
      saveData();
    }
    return changed;
  }
  function materializeRecurringHistory(){
    const starts = data.recurring
      .map(r => r && r.startDate ? r.startDate.slice(0,7) : null)
      .filter(Boolean)
      .sort();
    if(!starts.length) return;
    const [sy, sm] = starts[0].split('-').map(Number);
    const ey = today.getFullYear();
    const em = today.getMonth();
    let y = sy, m = sm - 1;
    while(y < ey || (y === ey && m <= em)){
      materializeRecurringForMonth(y, m);
      m++;
      if(m > 11){ m = 0; y++; }
    }
  }


  function populateCategorySelect(){
    const sel = $('inpCategory');
    const prevVal = sel.value;
    sel.innerHTML = data.categories.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
    if(data.categories.some(c=>c.id===prevVal)) sel.value = prevVal;

    const filterSel = $('filterCategory');
    if(filterSel){
      const prevFilter = filterSel.value;
      filterSel.innerHTML = [
        '<option value="all">All categories</option>',
        '<option value="needs">Needs</option>',
        '<option value="wants">Wants</option>',
        '<option value="savings">Savings</option>',
        ...data.categories.map(c => `<option value="${c.id}">${c.label}</option>`)
      ].join('');
      filterSel.value = prevFilter || 'all';
    }

    const goalSel = $('inpSavingsGoal');
    if(goalSel){
      const prevGoal = goalSel.value;
      goalSel.innerHTML = ['<option value="">General savings</option>', ...goalList().map(g => `<option value="${g.id}">${escapeHtml(g.name || 'Savings goal')}</option>`)].join('');
      goalSel.value = goalList().some(g => g.id === prevGoal) ? prevGoal : '';
    }
  }

  function renderHeader(){
    $('monthLabel').textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;
  }

  function renderSummary(){
    const budget = getBudgetFor(viewYear, viewMonth);
    const exps = expensesFor(viewYear, viewMonth);
    const incs = incomeFor(viewYear, viewMonth);
    const spent = exps.reduce((s,e)=>s+e.amount,0);
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
      $('tapeCaption').textContent = 'No budget set — tap the amount above to set one.';
    } else {
      const usedPct = Math.round((spent/budget)*100);
      $('tapeCaption').textContent = isCurrent
        ? `Day ${dayOfMonth} of ${daysInMonth} — ${usedPct}% of budget used`
        : `${daysInMonth} days — ${usedPct}% of budget used`;
    }
  }

  function bucketTotals(y,m){
    const exps = expensesFor(y,m);
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
    const exps = expensesFor(viewYear, viewMonth);
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

  function totalSaved(goalId = ''){
    return data.expenses
      .filter(e => e.category === 'savings' && ((goalId || '') === (e.goalId || '') || (!goalId && !e.goalId)))
      .reduce((s,e)=>s+e.amount, 0);
  }

  function renderGoal(){
    const goalEl = $('goalContent');
    const goals = goalList();
    const generalSaved = totalSaved('');

    const rows = [];
    if(goals.length){
      goals.forEach(g => {
        const saved = totalSaved(g.id);
        const pct = g.target > 0 ? Math.min(100, (saved / g.target) * 100) : 0;
        const reached = saved >= g.target;
        const remaining = Math.max(0, g.target - saved);
        rows.push(`
          <div class="goal-item" data-goal="${g.id}">
            <div class="goal-item-head">
              <div>
                <div class="goal-item-name">${escapeHtml(g.name || 'Savings goal')}</div>
                <div class="goal-item-meta">Target ${fmt(g.target)}</div>
              </div>
              <div class="goal-item-actions">
                <button type="button" class="row-btn" data-edit-goal="${g.id}">Edit</button>
                <button type="button" class="row-btn" data-del-goal="${g.id}">Delete</button>
              </div>
            </div>
            <div class="goal-bar"><div class="goal-fill ${reached ? 'reached' : ''}" style="width:${pct}%"></div></div>
            <div class="goal-item-stats">
              <span class="${reached ? 'good' : ''}">${reached ? 'Reached' : `${Math.round(pct)}% complete`}</span>
              <span>${fmt(saved)} saved · ${fmt(remaining)} left</span>
            </div>
          </div>`);
      });
    }

    if(generalSaved > 0 || !goals.length){
      rows.push(`
        <div class="goal-item">
          <div class="goal-item-head">
            <div>
              <div class="goal-item-name">General savings</div>
              <div class="goal-item-meta">Savings not assigned to a goal</div>
            </div>
          </div>
          <div class="goal-item-stats">
            <span>${fmt(generalSaved)} saved</span>
            <span class="goal-subtle">Use this as a holding bucket</span>
          </div>
        </div>`);
    }

    if(!rows.length){
      goalEl.innerHTML = '<p class="goal-empty">No goals yet. Tap Add goal to create one.</p>';
      return;
    }

    goalEl.innerHTML = `<div class="goal-list">${rows.join('')}</div>`;

    goalEl.querySelectorAll('[data-edit-goal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const goal = goalList().find(g => g.id === btn.getAttribute('data-edit-goal'));
        if(goal) openGoalSheet(goal);
      });
    });
    goalEl.querySelectorAll('[data-del-goal]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const goalId = btn.getAttribute('data-del-goal');
        const goal = goalList().find(g => g.id === goalId);
        if(!goal) return;
        const ok = confirm(`Delete goal "${goal.name || 'Savings goal'}"? Savings entries assigned to it will move back to General savings.`);
        if(!ok) return;
        data.goals = goalList().filter(g => g.id !== goalId);
        data.expenses.forEach(e => { if(e.category === 'savings' && e.goalId === goalId) delete e.goalId; });
        syncPrimaryGoal();
        populateCategorySelect();
        await saveData();
        renderAll();
      });
    });
  }

  function renderExpenseList(){
    const exps = filteredExpensesFor(viewYear, viewMonth);
    const listEl = $('expenseList');
    const emptyEl = $('emptyState');

    if(exps.length === 0){
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      updateSearchSummary();
      return;
    }
    emptyEl.style.display = 'none';

    const groups = {};
    exps.forEach(e => { (groups[e.date] = groups[e.date] || []).push(e); });
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
              <div class="exp-cat">${c.label}</div>
            </div>
            <span class="exp-amt">${fmt(e.amount)}</span>
            <div class="exp-actions">
              <button class="row-btn" data-edit="${e.id}" aria-label="Edit">Edit</button>
              <button class="exp-del row-btn" data-del="${e.id}" aria-label="Delete">✕</button>
            </div>
          </div>`;
      }).join('');
      return `<div class="day-group"><div class="day-label">${label}</div>${rows}</div>`;
    }).join('');

    listEl.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        data.expenses = data.expenses.filter(e => e.id !== btn.getAttribute('data-del'));
        await saveData();
        renderAll();
      });
    });
    listEl.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = data.expenses.find(e => e.id === btn.getAttribute('data-edit'));
        if(item) openSheet('expense', item);
      });
    });
    updateSearchSummary();
  }

  function renderIncomeList(){
    const incs = filteredIncomeFor(viewYear, viewMonth);
    const listEl = $('incomeList');
    const emptyEl = $('emptyIncomeState');

    if(incs.length === 0){
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      updateSearchSummary();
      return;
    }
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
          <div class="exp-actions">
            <button class="row-btn" data-editinc="${i.id}" aria-label="Edit">Edit</button>
            <button class="exp-del row-btn" data-delinc="${i.id}" aria-label="Delete">✕</button>
          </div>
        </div>`;
    }).join('');

    listEl.innerHTML = `<div class="income-total-row"><span class="t-label">Total this month</span><span class="t-val">${fmt(total)}</span></div>${rows}`;

    listEl.querySelectorAll('[data-delinc]').forEach(btn => {
      btn.addEventListener('click', async () => {
        data.income = data.income.filter(i => i.id !== btn.getAttribute('data-delinc'));
        syncBudgetToIncome(viewYear, viewMonth);
        await saveData();
        renderAll();
      });
    });
    listEl.querySelectorAll('[data-editinc]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = data.income.find(i => i.id === btn.getAttribute('data-editinc'));
        if(item) openSheet('income', item);
      });
    });
    updateSearchSummary();
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
      const spent = data.expenses.filter(e=>e.date.slice(0,7)===key).reduce((s,e)=>s+e.amount,0);
      const income = data.income.filter(i=>i.date.slice(0,7)===key).reduce((s,i)=>s+i.amount,0);
      const budget = getBudgetFor(my, mm);
      const label = `${MONTH_NAMES[mm]} ${my}`;

      let saved, basisLabel;
      if(income > 0){
        saved = income - spent;
        basisLabel = `spent ${fmt(spent)} of ${fmt(income)} income`;
      } else if(budget > 0){
        saved = budget - spent;
        basisLabel = `spent ${fmt(spent)} of ${fmt(budget)} budget`;
      } else {
        saved = null;
        basisLabel = `spent ${fmt(spent)}`;
      }
      const savedText = saved === null ? '—' : (saved>=0?'+':'−') + fmt(Math.abs(saved));
      const savedClass = saved === null ? '' : (saved >= 0 ? 'good' : 'bad');

      return `
        <div class="hist-row" data-jump="${key}">
          <div>
            <div class="hist-month">${label}</div>
            <div class="hist-sub">${basisLabel}</div>
          </div>
          <div class="hist-saved ${savedClass}">${savedText}</div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('[data-jump]').forEach(row => {
      row.addEventListener('click', () => {
        const [y,m] = row.getAttribute('data-jump').split('-').map(Number);
        viewYear = y; viewMonth = m-1;
        setTab('expenses');
        renderAll();
      });
    });
  }

  function renderChart(){
    const budget = getBudgetFor(viewYear, viewMonth);
    const daysInMonth = new Date(viewYear, viewMonth+1, 0).getDate();
    const isCurrent = (viewYear === today.getFullYear() && viewMonth === today.getMonth());
    const dayOfMonth = isCurrent ? today.getDate() : daysInMonth;
    const exps = expensesFor(viewYear, viewMonth);

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
    if(isCurrent && dayOfMonth < daysInMonth){
      const dailyRate = running / dayOfMonth;
      for(let d=dayOfMonth; d<=daysInMonth; d++){
        projected[d-1] = running + dailyRate * (d - dayOfMonth);
      }
      projectedTotal = running + dailyRate * (daysInMonth - dayOfMonth);
    }

    const budgetLine = new Array(daysInMonth).fill(budget || null);
    const labels = Array.from({length:daysInMonth}, (_,i)=>i+1);

    const badge = $('projBadge');
    const note = $('chartNote');
    if(!isCurrent){
      badge.textContent = 'closed month';
      badge.className = 'proj-badge';
      note.textContent = `Total spend for ${MONTH_NAMES[viewMonth]}: ${fmt(actual[daysInMonth-1] || 0)}.`;
    } else if(budget === 0){
      badge.textContent = 'no budget set';
      badge.className = 'proj-badge';
      note.textContent = `At the current pace you're projected to spend ${fmt(projectedTotal)} by ${MONTH_NAMES[viewMonth]} ${daysInMonth}. Set a budget to compare.`;
    } else if(projectedTotal > budget){
      badge.textContent = `over by ${fmt(projectedTotal - budget)}`;
      badge.className = 'proj-badge bad';
      note.textContent = `At your current daily pace, you're on track to spend ${fmt(projectedTotal)} by month end — ${fmt(projectedTotal-budget)} over your ${fmt(budget)} budget.`;
    } else {
      badge.textContent = `${fmt(budget - projectedTotal)} to spare`;
      badge.className = 'proj-badge good';
      note.textContent = `At your current daily pace, you're on track to spend ${fmt(projectedTotal)} by month end, staying under your ${fmt(budget)} budget.`;
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

    return { projectedTotal, budget, isCurrent };
  }

  function renderAdvice(chartInfo){
    const income = incomeFor(viewYear, viewMonth).reduce((s,i)=>s+i.amount,0);
    const spent = expensesFor(viewYear, viewMonth).reduce((s,e)=>s+e.amount,0);
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

    if(chartInfo && chartInfo.isCurrent && chartInfo.budget > 0 && chartInfo.projectedTotal > chartInfo.budget){
      tips.push({ type:'warn', text:`Your projected month-end spending (${fmt(chartInfo.projectedTotal)}) is on track to exceed your budget. Slowing your pace now is easier than catching up in the final week.` });
    }

    if(data.goal && data.goal.target){
      const saved = totalSaved();
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


  function upcomingOccurrences(){
    const upcoming = [];
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 60);
    for(const template of data.recurring || []){
      if(!template || !template.active) continue;
      const next = nextRecurringOccurrence(template);
      if(!next || next > horizon) continue;
      upcoming.push({ template, next });
    }
    return upcoming.sort((a,b) => a.next - b.next);
  }

  function renderUpcoming(){
    const listEl = $('upcomingList');
    const items = upcomingOccurrences().slice(0, 6);
    const badge = $('upcomingBadge');
    if(!items.length){
      badge.textContent = 'None';
      listEl.innerHTML = '<p class="goal-empty">No upcoming recurring items yet.</p>';
      return;
    }
    badge.textContent = `${items.length} soon`;
    listEl.innerHTML = `<div class="upcoming-list">${
      items.map(({template,next}) => {
        const isIncome = template.type === 'income';
        const name = isIncome ? (template.source || 'Paycheck') : (template.note || catInfo(template.category).label);
        const sub = isIncome ? fmt(template.amount) : `${fmt(template.amount)} · ${catInfo(template.category).label}`;
        return `
          <div class="upcoming-row">
            <div>
              <div class="upcoming-name">${escapeHtml(name)}</div>
              <div class="upcoming-sub">${escapeHtml(sub)}</div>
            </div>
            <div class="upcoming-date">${next.toLocaleDateString('en-US', { month:'short', day:'numeric' })}</div>
          </div>`;
      }).join('')
    }</div>`;
  }

  function reportTransactionsForMonth(){
    const expenses = expensesFor(viewYear, viewMonth).map(e => ({ ...e, kind:'expense' }));
    const income = incomeFor(viewYear, viewMonth).map(i => ({ ...i, kind:'income' }));
    return [...expenses, ...income].sort((a,b) => a.date === b.date ? a.kind.localeCompare(b.kind) : (a.date < b.date ? 1 : -1));
  }

  function downloadBlob(filename, content, mime='text/plain;charset=utf-8'){
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  function buildCsvReport(){
    const rows = [['date','type','category/source','note','amount','goal']];
    reportTransactionsForMonth().forEach(txn => {
      if(txn.kind === 'expense'){
        rows.push([txn.date, 'expense', catInfo(txn.category).label, txn.note || '', txn.amount.toFixed(2), txn.goalId ? goalLabel(txn.goalId) : '']);
      } else {
        rows.push([txn.date, 'income', txn.source || 'Paycheck', '', txn.amount.toFixed(2), '']);
      }
    });
    return rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
  }

  function buildMonthlySummary(){
    const income = incomeFor(viewYear, viewMonth).reduce((s,i)=>s+i.amount, 0);
    const spent = expensesFor(viewYear, viewMonth).reduce((s,e)=>s+e.amount, 0);
    const balance = income - spent;
    const savings = data.expenses.filter(e => e.category === 'savings' && e.date.slice(0,7) === monthKey(viewYear, viewMonth)).reduce((s,e)=>s+e.amount,0);
    const topCat = Object.entries(expensesFor(viewYear, viewMonth).reduce((acc,e)=>{ acc[e.category]=(acc[e.category]||0)+e.amount; return acc; }, {}))
      .sort((a,b)=>b[1]-a[1])[0];
    return {
      income, spent, balance, savings,
      topCategory: topCat ? catInfo(topCat[0]).label : 'None'
    };
  }

  function renderReports(){
    const summary = buildMonthlySummary();
    $('reportBadge').textContent = `${MONTH_NAMES[viewMonth].slice(0,3)} ${viewYear}`;
    $('reportSummary').textContent = `Income ${fmt(summary.income)} · Spent ${fmt(summary.spent)} · Balance ${fmt(Math.abs(summary.balance))} · Top category ${summary.topCategory}.`;
  }

  function renderAnalytics(){
    const spentByCat = expensesFor(viewYear, viewMonth).reduce((acc,e) => {
      acc[e.category] = (acc[e.category] || 0) + e.amount;
      return acc;
    }, {});
    const items = Object.entries(spentByCat).sort((a,b) => b[1]-a[1]);
    const total = items.reduce((s, [,amt]) => s+amt, 0);
    const income = incomeFor(viewYear, viewMonth).reduce((s,i)=>s+i.amount,0);
    const savingsAmt = data.expenses.filter(e => e.category==='savings' && e.date.slice(0,7)===monthKey(viewYear,viewMonth)).reduce((s,e)=>s+e.amount,0);
    $('analyticsBadge').textContent = income > 0 ? `${Math.round((savingsAmt/Math.max(1,income))*100)}% saved` : 'No income';
    $('analyticsSub').textContent = items.length ? `Your biggest spending categories this month are shown below.` : 'Add expenses to see category analytics.';
    const summaryEl = $('analyticsSummary');
    const top = items[0];
    const biggest = top ? catInfo(top[0]).label : 'None';
    const biggestVal = top ? fmt(top[1]) : '$0.00';
    const totalIncome = fmt(income);
    const totalSpent = fmt(total);
    summaryEl.innerHTML = `
      <div class="stat-chip"><span class="stat-label">Income</span><span class="stat-value">${totalIncome}</span></div>
      <div class="stat-chip"><span class="stat-label">Spent</span><span class="stat-value">${totalSpent}</span></div>
      <div class="stat-chip"><span class="stat-label">Top category</span><span class="stat-value">${escapeHtml(biggest)}</span></div>
      <div class="stat-chip"><span class="stat-label">Largest category</span><span class="stat-value">${biggestVal}</span></div>
    `;
    const ctx = $('categoryChart').getContext('2d');
    if(categoryChart) categoryChart.destroy();
    categoryChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: items.map(([cat]) => catInfo(cat).label),
        datasets: [{
          data: items.map(([,amt]) => amt),
          backgroundColor: items.map(([cat], idx) => data.categories.find(c => c.id === cat)?.color || DEFAULT_CATS[idx % DEFAULT_CATS.length].color),
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: '#eae4d6', boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } } }
      }
    });
  }

  function printMonthlyReport(){
    const summary = buildMonthlySummary();
    const goals = goalList();
    const rows = reportTransactionsForMonth().map(txn => {
      const detail = txn.kind === 'expense' ? `${catInfo(txn.category).label}${txn.goalId ? ` · ${goalLabel(txn.goalId)}` : ''}` : (txn.source || 'Paycheck');
      const amount = txn.kind === 'income' ? `+${fmt(txn.amount)}` : fmt(txn.amount);
      return `<tr><td>${txn.date}</td><td>${txn.kind}</td><td>${detail}</td><td>${txn.note || ''}</td><td>${amount}</td></tr>`;
    }).join('');
    const goalRows = goals.map(g => `<li>${escapeHtml(g.name || 'Savings goal')}: ${fmt(totalSaved(g.id))} / ${fmt(g.target)}</li>`).join('');
    const w = window.open('', '_blank', 'width=900,height=700');
    if(!w) return;
    w.document.write(`
      <html><head><title>Monthly Report</title>
      <style>
        body{font-family:Arial,sans-serif;padding:24px;color:#222}
        h1,h2{margin:0 0 10px}
        .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}
        .box{border:1px solid #ddd;border-radius:10px;padding:12px}
        table{width:100%;border-collapse:collapse;margin-top:16px}
        th,td{border-bottom:1px solid #eee;padding:8px;text-align:left;font-size:12px}
      </style></head><body>
      <h1>Monthly Report - ${MONTH_NAMES[viewMonth]} ${viewYear}</h1>
      <div class="grid">
        <div class="box"><strong>Income</strong><div>${fmt(summary.income)}</div></div>
        <div class="box"><strong>Spent</strong><div>${fmt(summary.spent)}</div></div>
        <div class="box"><strong>Balance</strong><div>${fmt(Math.abs(summary.balance))}</div></div>
        <div class="box"><strong>Top category</strong><div>${escapeHtml(summary.topCategory)}</div></div>
      </div>
      <h2>Savings goals</h2>
      <ul>${goalRows || '<li>No goals yet</li>'}</ul>
      <h2>Transactions</h2>
      <table><thead><tr><th>Date</th><th>Type</th><th>Detail</th><th>Note</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <script>window.onload=()=>window.print();<\/script>
      </body></html>
    `);
    w.document.close();
  }
  function renderAll(){
    materializeRecurringForMonth(viewYear, viewMonth);
    renderHeader();
    renderSummary();
    renderRule();
    renderCategoryBudgets();
    renderRecurringList();
    renderGoal();
    renderUpcoming();
    renderAnalytics();
    renderReports();
    renderExpenseList();
    renderIncomeList();
    renderHistory();
    const chartInfo = renderChart();
    renderAdvice(chartInfo);
    updateSearchSummary();
  }

  function setTab(tab){
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===tab));
    $('expensesPane').classList.toggle('active', tab==='expenses');
    $('incomePane').classList.toggle('active', tab==='income');
    $('historyPane').classList.toggle('active', tab==='history');
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

  function bindSearchControls(){
    $('searchInput').addEventListener('input', () => {
      searchState.query = $('searchInput').value || '';
      renderAll();
    });
    $('filterCategory').addEventListener('change', () => {
      searchState.category = $('filterCategory').value || 'all';
      renderAll();
    });
    $('filterType').addEventListener('change', () => {
      searchState.type = $('filterType').value || 'all';
      renderAll();
    });
  }
  bindSearchControls();

  $('prevMonth').addEventListener('click', () => { viewMonth--; if(viewMonth<0){viewMonth=11; viewYear--;} renderAll(); });
  $('nextMonth').addEventListener('click', () => { viewMonth++; if(viewMonth>11){viewMonth=0; viewYear++;} renderAll(); });

  function setEntryMode(mode){
    entryMode = mode;
    $('toggleExpense').classList.toggle('active', mode==='expense');
    $('toggleIncome').classList.toggle('active', mode==='income');
    $('toggleSavings').classList.toggle('active', mode==='savings');
    $('categoryField').style.display = mode==='expense' ? 'block' : 'none';
    $('noteField').style.display = mode==='expense' ? 'block' : 'none';
    $('sourceField').style.display = mode==='income' ? 'block' : 'none';
    $('savingsNoteField').style.display = mode==='savings' ? 'block' : 'none';
    $('savingsGoalField').style.display = mode==='savings' ? 'block' : 'none';
  }
  $('toggleExpense').addEventListener('click', () => setEntryMode('expense'));
  $('toggleIncome').addEventListener('click', () => setEntryMode('income'));
  $('toggleSavings').addEventListener('click', () => setEntryMode('savings'));

  function openSheet(mode, preset){
    editingId = preset ? preset.id : null;
    setEntryMode(mode || 'expense');
    $('inpAmount').value = preset ? preset.amount : '';
    $('inpNote').value = preset && preset.note ? preset.note : '';
    $('inpSource').value = preset && preset.source ? preset.source : '';
    $('inpSavingsNote').value = preset && preset.category === 'savings' ? (preset.note || '') : '';
    $('inpCategory').value = preset && preset.category ? preset.category : 'food';
    const d = preset && preset.date
      ? parseDateYMD(preset.date)
      : new Date(viewYear, viewMonth, Math.min(today.getDate(), new Date(viewYear,viewMonth+1,0).getDate()));
    $('inpDate').value = d ? formatDateYMD(d) : '';
    $('inpRecurring').checked = false;
    $('recurringFields').style.display = 'none';
    $('inpFrequency').value = 'monthly';
    $('inpRecurringStart').value = $('inpDate').value;
    $('inpRecurringEnd').value = '';
    $('inpSavingsGoal').value = preset && preset.goalId ? preset.goalId : '';
    $('sheet').classList.add('open');
  }
  function closeSheet(){
    editingId = null;
    $('sheet').classList.remove('open');
  }

  function recurringTemplateFromForm(amount, date){
    const type = entryMode === 'income' ? 'income' : 'expense';
    const template = {
      id: 'r' + Date.now() + Math.random().toString(36).slice(2,7),
      type,
      amount,
      frequency: $('inpFrequency').value || 'monthly',
      startDate: $('inpRecurringStart').value || date,
      endDate: $('inpRecurringEnd').value || '',
      active: true
    };
    if(type === 'income'){
      template.source = $('inpSource').value.trim() || 'Paycheck';
    } else {
      template.category = entryMode === 'savings' ? 'savings' : $('inpCategory').value;
      template.note = entryMode === 'savings' ? $('inpSavingsNote').value.trim() : $('inpNote').value.trim();
    }
    return template;
  }

  function persistEntryFromForm(existing){
    const amount = parseFloat($('inpAmount').value);
    if(!amount || amount <= 0){ $('inpAmount').focus(); return false; }
    const date = $('inpDate').value || new Date().toISOString().slice(0,10);
    const [y,m] = date.split('-').map(Number);

    const recurringEnabled = $('inpRecurring').checked;
    let recurringId = existing && existing.recurringId ? existing.recurringId : null;
    if(recurringEnabled && !recurringId){
      const template = recurringTemplateFromForm(amount, date);
      data.recurring.push(template);
      recurringId = template.id;
    }

    if(existing){
      data.expenses = data.expenses.filter(e => e.id !== existing.id);
      data.income = data.income.filter(i => i.id !== existing.id);
    }

    if(entryMode === 'income'){
      const source = $('inpSource').value.trim() || (existing && existing.source) || 'Paycheck';
      data.income.push({ id: existing ? existing.id : 'i'+Date.now()+Math.random().toString(36).slice(2,7), amount, source, date, recurringId });
      syncBudgetToIncome(y, m-1);
    } else {
      const category = entryMode === 'savings' ? 'savings' : $('inpCategory').value;
      const note = entryMode === 'savings' ? $('inpSavingsNote').value.trim() : $('inpNote').value.trim();
      const goalId = entryMode === 'savings' ? $('inpSavingsGoal').value || '' : '';
      data.expenses.push({ id: existing ? existing.id : 'e'+Date.now()+Math.random().toString(36).slice(2,7), amount, category, note, date, recurringId, goalId });
    }

    return { y, m, recurringEnabled };
  }

  $('addBtn').addEventListener('click', () => openSheet('expense'));
  $('addRecurringBtn').addEventListener('click', () => {
    openSheet('expense');
    $('inpRecurring').checked = true;
    $('recurringFields').style.display = 'block';
  });
  $('cancelBtn').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', e => { if(e.target.id==='sheet') closeSheet(); });

  $('inpRecurring').addEventListener('change', () => {
    $('recurringFields').style.display = $('inpRecurring').checked ? 'block' : 'none';
  });

  $('saveBtn').addEventListener('click', async () => {
    const existing = editingId ? (data.expenses.find(e => e.id === editingId) || data.income.find(i => i.id === editingId)) : null;
    const saved = persistEntryFromForm(existing);
    if(!saved) return;
    const { y, m, recurringEnabled } = saved;
    viewYear = y;
    viewMonth = m - 1;
    await saveData();
    if(recurringEnabled){
      materializeRecurringForMonth(viewYear, viewMonth);
      materializeRecurringHistory();
      await saveData();
    }
    closeSheet();
    renderAll();
  });

  function openBudgetSheet(){
    $('budgetMonthLabel').textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;
    $('inpBudget').value = getBudgetFor(viewYear, viewMonth) || '';
    $('budgetSheet').classList.add('open');
  }
  function closeBudgetSheet(){ $('budgetSheet').classList.remove('open'); }
  $('budgetNum').addEventListener('click', openBudgetSheet);
  $('budgetCancelBtn').addEventListener('click', closeBudgetSheet);
  $('budgetSheet').addEventListener('click', e => { if(e.target.id==='budgetSheet') closeBudgetSheet(); });
  $('budgetSaveBtn').addEventListener('click', async () => {
    const val = parseFloat($('inpBudget').value);
    data.budgets[monthKey(viewYear, viewMonth)] = isNaN(val) ? 0 : val;
    await saveData();
    closeBudgetSheet();
    renderAll();
  });

  // ---------- category budgets / manage categories ----------
  function renderManageCatList(){
    const usageCount = {};
    data.expenses.forEach(e => { usageCount[e.category] = (usageCount[e.category]||0) + 1; });

    $('manageCatList').innerHTML = data.categories.map(c => {
      const budget = getCategoryBudgetFor(viewYear, viewMonth, c.id);
      const count = usageCount[c.id] || 0;
      const usageNote = count > 0 ? `<div class="manage-cat-bucket">${c.bucket} · used ${count}×</div>` : `<div class="manage-cat-bucket">${c.bucket}</div>`;
      return `
        <div class="manage-row" data-cat="${c.id}">
          <div class="manage-cat-info">
            <span class="cat-dot" style="background:${c.color}"></span>
            <div style="min-width:0;">
              <div class="manage-cat-name">${escapeHtml(c.label)}</div>
              ${usageNote}
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
  function openGoalSheet(goal = null){
    editingGoalId = goal ? goal.id : null;
    $('inpGoalName').value = goal ? (goal.name || '') : '';
    $('inpGoalTarget').value = goal ? (goal.target || '') : '';
    $('goalClearBtn').textContent = editingGoalId ? 'Delete goal' : 'Clear form';
    $('goalSheet').classList.add('open');
  }
  function closeGoalSheet(){ $('goalSheet').classList.remove('open'); editingGoalId = null; }
  $('editGoalBtn').addEventListener('click', () => openGoalSheet());
  $('goalCancelBtn').addEventListener('click', closeGoalSheet);
  $('goalSheet').addEventListener('click', e => { if(e.target.id==='goalSheet') closeGoalSheet(); });

  $('goalSaveBtn').addEventListener('click', async () => {
    const name = $('inpGoalName').value.trim();
    const target = parseFloat($('inpGoalTarget').value);
    if(!target || target <= 0){ $('inpGoalTarget').focus(); return; }
    const goals = goalList().filter(g => g.id !== editingGoalId);
    const newGoal = { id: editingGoalId || ('g'+Date.now()+Math.random().toString(36).slice(2,7)), name, target };
    goals.unshift(newGoal);
    data.goals = goals;
    syncPrimaryGoal();
    populateCategorySelect();
    await saveData();
    closeGoalSheet();
    renderAll();
  });

  $('goalClearBtn').addEventListener('click', async () => {
    if(editingGoalId){
      const goal = goalList().find(g => g.id === editingGoalId);
      const ok = confirm(`Delete goal "${goal ? goal.name || 'Savings goal' : 'this goal'}"?`);
      if(!ok) return;
      data.goals = goalList().filter(g => g.id !== editingGoalId);
      data.expenses.forEach(e => { if(e.category === 'savings' && e.goalId === editingGoalId) delete e.goalId; });
      syncPrimaryGoal();
      populateCategorySelect();
      await saveData();
      closeGoalSheet();
      renderAll();
    } else {
      $('inpGoalName').value = '';
      $('inpGoalTarget').value = '';
    }
  });

  $('downloadCsvBtn').addEventListener('click', () => {
    const filename = `expense-report-${monthKey(viewYear, viewMonth)}.csv`;
    downloadBlob(filename, buildCsvReport(), 'text/csv;charset=utf-8');
  });
  $('downloadJsonBtn').addEventListener('click', () => {
    const filename = `expense-backup-${monthKey(viewYear, viewMonth)}.json`;
    downloadBlob(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  });
  $('printReportBtn').addEventListener('click', printMonthlyReport);

  async function init(){

    populateCategorySelect();
    const failsafe = setTimeout(() => {
      $('loadingState').style.display = 'none';
      $('mainContent').style.display = 'block';
    }, 4000);
    try{
      await loadData();
      syncPrimaryGoal();
      populateCategorySelect();
      materializeRecurringHistory();
      await saveData();
    }catch(e){
      console.log('Load failed unexpectedly, starting fresh.', e);
    }
    clearTimeout(failsafe);
    syncPrimaryGoal();
    populateCategorySelect();
    $('loadingState').style.display = 'none';
    $('mainContent').style.display = 'block';
    renderAll();
  }

  init();
})();
