/* ---------- Banco local (IndexedDB) ---------- */
const DB = {
  abrir() {
    return new Promise((ok, falha) => {
      const r = indexedDB.open('folga', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('config');
        r.result.createObjectStore('lancamentos', { keyPath: 'id', autoIncrement: true }); // usado na Etapa 3
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => falha(r.error);
    });
  },
  async ler(chave) {
    const d = await this.abrir();
    return new Promise(ok => { const q = d.transaction('config').objectStore('config').get(chave); q.onsuccess = () => ok(q.result); });
  },
  async gravar(chave, valor) {
    const d = await this.abrir();
    return new Promise((ok, falha) => {
      const t = d.transaction('config', 'readwrite'); t.objectStore('config').put(valor, chave);
      t.oncomplete = ok; t.onerror = () => falha(t.error);
    });
  }
};

const LANC = {
  async op(modo, fn) {
    const d = await DB.abrir();
    return new Promise((ok, falha) => { const st = d.transaction('lancamentos', modo).objectStore('lancamentos'); fn(st, ok, falha); });
  },
  todos() { return this.op('readonly', (st, ok) => { const q = st.getAll(); q.onsuccess = () => ok(q.result); }); },
  salvar(l) { return this.op('readwrite', (st, ok, f) => { const q = st.put(l); q.onsuccess = () => ok(q.result); q.onerror = () => f(q.error); }); },
  apagar(id) { return this.op('readwrite', (st, ok) => { const q = st.delete(id); q.onsuccess = () => ok(); }); }
};

/* ---------- Utilidades ---------- */
const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dataCurta = iso => new Date(iso + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');

const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// Campo de dinheiro: o usuário digita só números e o valor vira R$ 1.234,56 (guardado em centavos)
function ligarDinheiro(el) {
  const aplicar = () => { const c = parseInt(el.value.replace(/\D/g, '') || '0', 10); el.dataset.c = c; el.value = c ? brl(c) : ''; };
  el.addEventListener('input', aplicar);
  if (el.dataset.c) el.value = brl(+el.dataset.c);
}

// Próxima data em que cai o "dia" (ajusta meses curtos, ex.: dia 31 em fevereiro)
function proximaData(dia, hoje = new Date()) {
  for (let m = 0; m < 3; m++) {
    const ult = new Date(hoje.getFullYear(), hoje.getMonth() + m + 1, 0).getDate();
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + m, Math.min(dia, ult));
    if (d >= new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) return d;
  }
}

const PADRAO = {
  margem: 10000,
  recebimentos: [
    { quem: 'eu', dia: 5, minimo: 0, medio: 0 },
    { quem: 'esposa', dia: 5, minimo: 0, medio: 0 },
    { quem: 'esposa', dia: 15, minimo: 0, medio: 0 },
    { quem: 'eu', dia: 20, minimo: 0, medio: 0 }
  ]
};

/* ---------- Motor de projeção ---------- */
// Saldo atual = saldo informado + receitas recebidas - despesas pagas DEPOIS do momento em que o saldo foi informado.
function saldoDe(cfg, lancs) {
  return cfg.saldo + lancs.filter(l => l.pago && (l.pagoEm || 0) >= cfg.saldoEm)
    .reduce((t, l) => t + (l.tipo === 'receita' ? l.valor : -l.valor), 0);
}

// Projeta o saldo dia a dia, de hoje até o próximo recebimento. 'extras' = compras hipotéticas [{i: dia, valor}] (Etapa 5).
function projetar(cfg, lancs, extras = []) {
  const h = new Date(); const hoje0 = new Date(h.getFullYear(), h.getMonth(), h.getDate());
  const amanha = new Date(h.getFullYear(), h.getMonth(), h.getDate() + 1);
  const idx = d => Math.round((d - hoje0) / 864e5);
  const datas = cfg.recebimentos.map(r => ({ ...r, data: proximaData(r.dia, amanha) }));
  const fim = datas.reduce((a, r) => (r.data < a ? r.data : a), datas[0].data);
  const dias = idx(fim);
  const saldoAtual = saldoDe(cfg, lancs);
  const delta = new Array(dias + 1).fill(0);
  let comprometido = 0; // despesas pendentes que vencem antes do próximo recebimento
  datas.forEach(r => { const i = idx(r.data); if (i <= dias) delta[i] += r.minimo; });
  const saidas = lancs.filter(l => l.tipo === 'despesa' && !l.pago).map(l => ({ i: Math.max(0, idx(new Date(l.data + 'T00:00:00'))), valor: l.valor })).concat(extras);
  saidas.forEach(x => { if (x.i <= dias) delta[x.i] -= x.valor; if (x.i < dias) comprometido += x.valor; });
  let s = saldoAtual; const curva = delta.map(d => (s += d));
  const livre = Math.floor((saldoAtual - comprometido - cfg.margem) / dias);
  let iMin = 0; for (let i = 1; i < dias; i++) if (curva[i] < curva[iMin]) iMin = i;
  const dMin = new Date(hoje0.getFullYear(), hoje0.getMonth(), hoje0.getDate() + iMin);
  return { saldoAtual, dias, fim, curva, livre, comprometido, aperto: { dia: dMin.getDate(), valor: curva[iMin] } };
}

function curvaSVG(curva, margem) {
  const n = curva.length - 1, W = 360, X0 = 20, XW = 320, Y0 = 14, YH = 92;
  const lo = Math.min(...curva, margem), hi = Math.max(...curva, margem), r = hi - lo || 1;
  const x = i => X0 + (i * XW) / n, y = v => Y0 + (1 - (v - lo) / r) * YH;
  let d = `M${x(0)} ${y(curva[0])}`;
  for (let i = 1; i <= n; i++) d += ` L${x(i)} ${y(curva[i - 1])} L${x(i)} ${y(curva[i])}`; // degraus: o saldo muda no dia do evento
  const pontos = curva.map((v, i) => (i < n && v < margem ? `<circle class="aperto" cx="${x(i)}" cy="${y(v)}" r="4"/>` : '')).join('');
  return `<svg class="curva" viewBox="0 0 ${W} 140" role="img" aria-label="Saldo projetado até o próximo recebimento">
    <line class="margem" x1="${X0}" x2="${X0 + XW}" y1="${y(margem)}" y2="${y(margem)}"/>
    <text class="rotulo" x="${X0}" y="${y(margem) - 4}">margem</text>
    <path class="linha" d="${d}"/>${pontos}
    <text class="eixo" x="${X0}" y="128">hoje</text><text class="eixo" x="${X0 + XW}" y="128" text-anchor="end">recebimento</text></svg>`;
}

/* ---------- Simulação de compra ---------- */
const isoDe = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const diasAte = d => { const h = new Date(); return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(h.getFullYear(), h.getMonth(), h.getDate())) / 864e5); };
const diaDoIndice = i => { const h = new Date(); return dataCurta(isoDe(new Date(h.getFullYear(), h.getMonth(), h.getDate() + i))); };
// Soma meses mantendo o dia (31 em mês curto vira o último dia)
function somaMes(d, k) { const ult = new Date(d.getFullYear(), d.getMonth() + k + 1, 0).getDate(); return new Date(d.getFullYear(), d.getMonth() + k, Math.min(d.getDate(), ult)); }

// Projeção longa (90 dias): recebimentos fixos (valor mínimo) + despesas pendentes já lançadas + extras.
function projetarLongo(cfg, lancs, extras = [], horizonte = 90) {
  const saldoAtual = saldoDe(cfg, lancs), h = new Date();
  const delta = new Array(horizonte + 1).fill(0);
  cfg.recebimentos.forEach(r => {
    for (let m = 0; m < 5; m++) {
      const ult = new Date(h.getFullYear(), h.getMonth() + m + 1, 0).getDate();
      const i = diasAte(new Date(h.getFullYear(), h.getMonth() + m, Math.min(r.dia, ult)));
      if (i >= 1 && i <= horizonte) delta[i] += r.minimo;
    }
  });
  lancs.filter(l => l.tipo === 'despesa' && !l.pago).forEach(l => { const i = Math.max(0, diasAte(new Date(l.data + 'T00:00:00'))); if (i <= horizonte) delta[i] -= l.valor; });
  extras.forEach(x => { if (x.i <= horizonte) delta[x.i] -= x.valor; });
  let s = saldoAtual; const curva = delta.map(d => (s += d));
  let iMin = 0; curva.forEach((v, i) => { if (v < curva[iMin]) iMin = i; });
  return { curva, iMin, min: curva[iMin] };
}

function curvaDupla(a, b, margem) {
  const n = a.length - 1, X0 = 20, XW = 320, Y0 = 14, YH = 92;
  const todos = [...a, ...b, margem], lo = Math.min(...todos), r = (Math.max(...todos) - lo) || 1;
  const x = i => X0 + (i * XW) / n, y = v => Y0 + (1 - (v - lo) / r) * YH;
  const cam = c => { let d = `M${x(0)} ${y(c[0])}`; for (let i = 1; i <= n; i++) d += ` L${x(i)} ${y(c[i - 1])} L${x(i)} ${y(c[i])}`; return d; };
  return `<svg class="curva" viewBox="0 0 360 140" role="img" aria-label="Saldo projetado com e sem a compra">
    <line class="margem" x1="${X0}" x2="${X0 + XW}" y1="${y(margem)}" y2="${y(margem)}"/><text class="rotulo" x="${X0}" y="${y(margem) - 4}">margem</text>
    <path class="base" d="${cam(a)}"/><path class="linha" d="${cam(b)}"/>
    <text class="eixo" x="${X0}" y="128">hoje</text><text class="eixo" x="${X0 + XW}" y="128" text-anchor="end">${n} dias</text></svg>`;
}

/* ---------- Contas recorrentes ---------- */
// Cada recorrente guarda: desc, valor, freq (mensal/semanal/anual), inicio (um vencimento) e 'gerados' (datas já criadas).
const CATEGORIAS = ['Alimentação', 'Casa', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Compras', 'Contas', 'Dívidas', 'Outros'];
const opcoesCat = sel => CATEGORIAS.map(c => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
const FREQ = { mensal: 'Todo mês', semanal: 'Toda semana', anual: 'Todo ano' };
function ocorrencia(r, k) {
  const ini = new Date(r.inicio + 'T00:00:00');
  return r.freq === 'semanal' ? new Date(ini.getFullYear(), ini.getMonth(), ini.getDate() + 7 * k) : somaMes(ini, r.freq === 'anual' ? 12 * k : k);
}
function proximaOcorrencia(r) { for (let k = 0; k < 2000; k++) { const d = ocorrencia(r, k); if (diasAte(d) >= 0) return d; } }

// Cria lançamentos pendentes dos próximos 120 dias. Roda ao abrir o app e é segura para repetir (não duplica).
async function gerarRecorrentes() {
  const lista = (await DB.ler('recorrentes')) || [];
  let mudou = false;
  for (const r of lista) {
    for (let k = 0; k < 2000; k++) {
      const d = ocorrencia(r, k), i = diasAte(d);
      if (i > 120) break;
      const iso = isoDe(d);
      if (i < 0 || r.gerados.includes(iso)) continue;
      await LANC.salvar({ tipo: 'despesa', desc: r.desc, valor: r.valor, data: iso, pago: false, pagoEm: null, recorrenteId: r.id, categoria: r.categoria || 'Contas' });
      r.gerados.push(iso); mudou = true;
    }
  }
  if (mudou) await DB.gravar('recorrentes', lista);
}

// Apaga os lançamentos futuros ainda não pagos desta recorrente e devolve a lista de datas que continuam valendo.
async function limparFuturos(r) {
  const meus = (await LANC.todos()).filter(l => l.recorrenteId === r.id);
  const futuros = meus.filter(l => !l.pago && l.data >= hojeISO());
  for (const l of futuros) await LANC.apagar(l.id);
  return meus.filter(l => !futuros.includes(l)).map(l => l.data);
}

function formRec(r) {
  const c = r ? { ...r, inicio: isoDe(proximaOcorrencia(r)) } : { desc: '', valor: 0, freq: 'mensal', inicio: hojeISO() };
  area.innerHTML = `<div class="form"><h2>${r ? 'Editar recorrente' : 'Nova recorrente'}</h2>
    <p class="intro">Ela cria sozinha os próximos lançamentos (até 4 meses à frente). Para contas de valor variável, use o valor médio.</p>
    <label>Descrição</label><input id="rd" value="${esc(c.desc)}" placeholder="Ex.: Aluguel" autocomplete="off">
    <label>Valor</label><input id="rv" class="valorgrande" inputmode="numeric" placeholder="R$ 0,00" data-c="${c.valor || ''}">
    <label>Categoria</label><select id="rcat">${opcoesCat(c.categoria || 'Contas')}</select>
    <label>Repete</label><select id="rf">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${c.freq === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <label>Próximo vencimento</label><input id="ri" type="date" value="${c.inicio}">
    <p class="erro" id="re" role="alert"></p>
    <button class="botao" id="rs">Salvar</button><button class="botao sec" id="rc">Cancelar</button></div>`;
  const $ = id => area.querySelector('#' + id);
  ligarDinheiro($('rv'));
  $('rc').onclick = () => mostrar('recorrentes');
  $('rs').onclick = async () => {
    const desc = $('rd').value.trim(), valor = +($('rv').dataset.c || 0), freq = $('rf').value, inicio = $('ri').value, categoria = $('rcat').value;
    const erro = m => { $('re').textContent = m; };
    if (!desc) return erro('Informe a descrição.');
    if (valor <= 0) return erro('Informe um valor maior que zero.');
    if (!inicio || isNaN(new Date(inicio + 'T00:00:00'))) return erro('Escolha uma data válida.');
    if (inicio < hojeISO()) return erro('O vencimento não pode estar no passado.');
    const lista = (await DB.ler('recorrentes')) || [];
    if (r) { const x = lista.find(y => y.id === r.id); x.gerados = await limparFuturos(x); Object.assign(x, { desc, valor, freq, inicio, categoria }); }
    else lista.push({ id: Date.now(), desc, valor, freq, inicio, categoria, gerados: [] });
    await DB.gravar('recorrentes', lista);
    await gerarRecorrentes();
    mostrar('recorrentes');
  };
}

/* ---------- Backup ---------- */
function validarBackup(b) {
  const int = v => Number.isInteger(v), dataOk = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + 'T00:00:00'));
  if (!b || b.app !== 'folga' || b.versao !== 1) return 'Este arquivo não é um backup do Folga.';
  const c = b.config;
  if (!c || !c.nomes || typeof c.nomes.eu !== 'string' || typeof c.nomes.esposa !== 'string' || !int(c.margem) || c.margem < 0 || !int(c.saldo) || typeof c.saldoEm !== 'number' || !Array.isArray(c.recebimentos) || !c.recebimentos.length) return 'A configuração do backup está incompleta.';
  if (!c.recebimentos.every(r => ['eu', 'esposa'].includes(r.quem) && int(r.dia) && r.dia >= 1 && r.dia <= 31 && int(r.minimo) && r.minimo > 0 && int(r.medio) && r.medio > 0)) return 'Os recebimentos do backup são inválidos.';
  if (!Array.isArray(b.lancamentos) || !b.lancamentos.every(l => ['despesa', 'receita'].includes(l.tipo) && typeof l.desc === 'string' && int(l.valor) && l.valor > 0 && dataOk(l.data) && typeof l.pago === 'boolean')) return 'Há lançamentos inválidos no backup.';
  if (!Array.isArray(b.recorrentes) || !b.recorrentes.every(r => int(r.id) && typeof r.desc === 'string' && int(r.valor) && r.valor > 0 && FREQ[r.freq] && dataOk(r.inicio) && Array.isArray(r.gerados))) return 'Há contas recorrentes inválidas no backup.';
  if (b.recebIgnorados !== undefined && !(Array.isArray(b.recebIgnorados) && b.recebIgnorados.every(x => typeof x === 'string'))) return 'Os recebimentos ignorados do backup são inválidos.';
  return null;
}

async function exportarBackup(msg) {
  const cfg = await DB.ler('config');
  if (!cfg || cfg.saldo === undefined) return msg('Termine a configuração na aba Hoje antes de fazer backup.', true);
  const dados = { app: 'folga', versao: 1, exportadoEm: new Date().toISOString(), config: cfg, recorrentes: (await DB.ler('recorrentes')) || [], recebIgnorados: (await DB.ler('recebIgnorados')) || [], lancamentos: await LANC.todos() };
  const nome = `folga-backup-${hojeISO()}.json`;
  const arquivo = new File([JSON.stringify(dados, null, 1)], nome, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [arquivo] })) await navigator.share({ files: [arquivo], title: 'Backup Folga' });
    else { const url = URL.createObjectURL(arquivo), a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
  } catch (e) { return msg(e.name === 'AbortError' ? 'Backup cancelado.' : 'Não foi possível exportar. Tente de novo.', true); }
  await DB.gravar('ultimoBackup', Date.now());
  msg(`Backup gerado com ${dados.lancamentos.length} lançamentos. Guarde o arquivo em Arquivos ou iCloud.`);
}

async function restaurarBackup(arquivo, msg) {
  let b;
  try { b = JSON.parse(await arquivo.text()); } catch { return msg('Não consegui ler o arquivo. Ele precisa ser um backup .json do Folga.', true); }
  const erro = validarBackup(b);
  if (erro) return msg(erro + ' Nada foi alterado.', true);
  if (!confirm(`Restaurar vai SUBSTITUIR todos os dados atuais por este backup (${b.lancamentos.length} lançamentos, feito em ${new Date(b.exportadoEm).toLocaleDateString('pt-BR')}). Continuar?`)) return msg('Restauração cancelada. Nada foi alterado.');
  const campos = ['id', 'tipo', 'desc', 'valor', 'data', 'pago', 'pagoEm', 'recorrenteId', 'categoria', 'recebKey', 'grupo', 'parcela', 'total'];
  const limpos = b.lancamentos.map(l => Object.fromEntries(campos.filter(k => l[k] !== undefined).map(k => [k, l[k]])));
  const d = await DB.abrir();
  try {
    await new Promise((ok, falha) => { // tudo ou nada: se algo falhar, os dados atuais ficam intactos
      const t = d.transaction(['config', 'lancamentos'], 'readwrite'), c = t.objectStore('config'), l = t.objectStore('lancamentos');
      l.clear(); c.put(b.config, 'config'); c.put(b.recorrentes, 'recorrentes'); c.put(b.recebIgnorados || [], 'recebIgnorados'); limpos.forEach(x => l.put(x));
      t.oncomplete = ok; t.onerror = t.onabort = () => falha(t.error);
    });
  } catch { return msg('Falha ao restaurar. Seus dados atuais foram mantidos.', true); }
  await gerarRecorrentes();
  mostrar('hoje');
}

/* ---------- Fechamento do mês ---------- */
const ymDe = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
// Receitas = salários fixos pelo valor MÉDIO (ainda não há confirmação do valor real) + receitas lançadas e recebidas.
function resumoMes(cfg, lancs, ym, ignorados = []) {
  const ini = new Date(cfg.saldoEm), iniYM = ymDe(ini);
  const doMes = lancs.filter(l => l.data.startsWith(ym));
  const [yy, mm] = ym.split('-').map(Number);
  const fixos = cfg.recebimentos.filter(r => {
    if (!(ym > iniYM || (ym === iniYM && r.dia >= ini.getDate()))) return false;
    const key = `${r.quem}${r.dia}-${isoDe(new Date(yy, mm - 1, Math.min(r.dia, new Date(yy, mm, 0).getDate())))}`;
    return !lancs.some(l => l.recebKey === key) && !ignorados.includes(key); // confirmado/ignorado não é mais estimativa
  }).reduce((t, r) => t + r.medio, 0);
  const soma = a => a.reduce((t, l) => t + l.valor, 0);
  const rec = soma(doMes.filter(l => l.tipo === 'receita' && l.pago));
  const desp = doMes.filter(l => l.tipo === 'despesa'), pagas = desp.filter(l => l.pago), pend = desp.filter(l => !l.pago);
  const porCat = {}; desp.forEach(l => { const c = l.categoria || 'Sem categoria'; porCat[c] = (porCat[c] || 0) + l.valor; });
  return { temDados: doMes.length > 0, fixos, rec, pagas: soma(pagas), nPagas: pagas.length, pend: soma(pend), nPend: pend.length,
           saldo: ym < iniYM ? -soma(pagas) + rec : fixos + rec - soma(pagas), cats: Object.entries(porCat).sort((a, b) => b[1] - a[1]) };
}

/* ---------- Gráfico da tela Hoje ---------- */
// Datas de recebimento dentro do horizonte (dias do mês iguais viram um só marco)
function marcosRecebimento(cfg, horizonte) {
  const h = new Date(), vistos = new Map();
  cfg.recebimentos.forEach(r => {
    for (let m = 0; m < 3; m++) {
      const ult = new Date(h.getFullYear(), h.getMonth() + m + 1, 0).getDate();
      const d = new Date(h.getFullYear(), h.getMonth() + m, Math.min(r.dia, ult)), i = diasAte(d);
      if (i >= 1 && i <= horizonte && !vistos.has(i)) vistos.set(i, 'dia ' + d.getDate());
    }
  });
  return [...vistos].map(([i, rot]) => ({ i, rot }));
}
function curvaHoje(curva, margem, marcos, iMin) {
  const n = curva.length - 1, X0 = 20, XW = 320, Y0 = 18, YH = 86;
  const lo = Math.min(...curva, margem), r = (Math.max(...curva, margem) - lo) || 1;
  const x = i => X0 + (i * XW) / n, y = v => Y0 + (1 - (v - lo) / r) * YH;
  let d = `M${x(0)} ${y(curva[0])}`;
  for (let i = 1; i <= n; i++) d += ` L${x(i)} ${y(curva[i - 1])} L${x(i)} ${y(curva[i])}`;
  const ticks = marcos.map(m => `<line class="marco" x1="${x(m.i)}" x2="${x(m.i)}" y1="${Y0}" y2="${Y0 + YH}"/><text class="eixo" x="${x(m.i)}" y="126" text-anchor="middle">${m.rot}</text>`).join('');
  const aperto = curva[iMin] < margem ? `<circle class="aperto" cx="${x(iMin)}" cy="${y(curva[iMin])}" r="5"/>` : '';
  return `<svg class="curva" viewBox="0 0 360 134" role="img" aria-label="Saldo projetado nos próximos ${n} dias">${ticks}
    <line class="margem" x1="${X0}" x2="${X0 + XW}" y1="${y(margem)}" y2="${y(margem)}"/><text class="rotulo" x="${X0 + XW}" y="${y(margem) - 4}" text-anchor="end">margem</text>
    <path class="linha" d="${d}"/><circle class="ponto" cx="${x(0)}" cy="${y(curva[0])}" r="4.5"/>${aperto}<text class="rotulo" x="${X0}" y="11">hoje</text></svg>`;
}

/* ---------- Confirmação de recebimentos e lembretes ---------- */
// Pagamentos fixos que já aconteceram (até 45 dias) e ainda não foram confirmados nem ignorados
function recebimentosAConfirmar(cfg, lancs, ignorados) {
  const ini = new Date(cfg.saldoEm), iniDia = new Date(ini.getFullYear(), ini.getMonth(), ini.getDate()), h = new Date(), saida = [];
  cfg.recebimentos.forEach(r => {
    for (let m = -2; m <= 0; m++) {
      const ult = new Date(h.getFullYear(), h.getMonth() + m + 1, 0).getDate();
      const d = new Date(h.getFullYear(), h.getMonth() + m, Math.min(r.dia, ult)), n = diasAte(d);
      if (n > 0 || n < -45 || d < iniDia) continue;
      const key = `${r.quem}${r.dia}-${isoDe(d)}`;
      if (lancs.some(l => l.recebKey === key) || ignorados.includes(key)) continue;
      saida.push({ key, r, d });
    }
  });
  return saida.sort((a, b) => a.d - b.d);
}

// Arquivo .ics com alarmes: contas pendentes (véspera e dia, 9h) e dias de pagamento (18h)
function gerarICS(cfg, lancs) {
  const pad = n => String(n).padStart(2, '0'), h = new Date();
  const dt = (d, hm) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${hm}00`;
  const tx = t => String(t).replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const carimbo = `${h.getUTCFullYear()}${pad(h.getUTCMonth() + 1)}${pad(h.getUTCDate())}T${pad(h.getUTCHours())}${pad(h.getUTCMinutes())}${pad(h.getUTCSeconds())}Z`;
  const ev = (uid, d, ini, fim, titulo, descr, alarmes) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${carimbo}`, `DTSTART:${dt(d, ini)}`, `DTEND:${dt(d, fim)}`,
    `SUMMARY:${tx(titulo)}`, `DESCRIPTION:${tx(descr)}`, ...alarmes.flatMap(t => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${tx(titulo)}`, `TRIGGER:${t}`, 'END:VALARM']), 'END:VEVENT'];
  const linhas = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Folga//PT-BR//', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Folga'];
  let nC = 0, nR = 0;
  lancs.filter(l => l.tipo === 'despesa' && !l.pago).forEach(l => {
    const d = new Date(l.data + 'T00:00:00'), n = diasAte(d);
    if (n < 0 || n > 120) return;
    nC++; linhas.push(...ev(`folga-c${l.id}@folga.app`, d, '0900', '0930', `Pagar: ${l.desc} (${brl(l.valor)})`, 'Lembrete do Folga. Depois de pagar, marque como paga no app.', ['-P1D', 'PT0S']));
  });
  const dias = new Map();
  cfg.recebimentos.forEach(r => {
    for (let m = 0; m < 3; m++) {
      const ult = new Date(h.getFullYear(), h.getMonth() + m + 1, 0).getDate();
      const d = new Date(h.getFullYear(), h.getMonth() + m, Math.min(r.dia, ult)), n = diasAte(d);
      if (n >= 0 && n <= 62) { const k = isoDe(d), g = dias.get(k) || { d, nomes: new Set() }; g.nomes.add(cfg.nomes[r.quem]); dias.set(k, g); }
    }
  });
  dias.forEach((g, k) => { nR++; linhas.push(...ev(`folga-r${k}@folga.app`, g.d, '1800', '1815', `Confirmar recebimento no Folga (${[...g.nomes].join(' + ')})`, 'Abra o Folga e informe o valor que chegou.', ['PT0S'])); });
  linhas.push('END:VCALENDAR');
  return { texto: linhas.join('\r\n'), nC, nR };
}

/* ---------- Aprendizado ---------- */
const media = a => a.reduce((t, v) => t + v, 0) / a.length;
const emReais = c => Math.round(c / 100) * 100;

// Sugere ajustar salários (a partir das confirmações) e contas recorrentes (a partir do que foi pago)
function sugestoesAjuste(cfg, lancs, recs, dispensadas) {
  const sug = [];
  cfg.recebimentos.forEach((r, i) => {
    const id = r.quem + r.dia;
    const reais = lancs.filter(l => l.recebKey && l.recebKey.split('-')[0] === id).sort((a, b) => b.data.localeCompare(a.data)).slice(0, 6).map(l => l.valor);
    if (reais.length < 3) return; // precisa de histórico mínimo
    const min = Math.min(...reais), med = Math.max(emReais(media(reais)), min), key = `rec:${id}:${min}:${med}`;
    if ((Math.abs(med - r.medio) / r.medio > 0.05 || Math.abs(min - r.minimo) / r.minimo > 0.05) && !dispensadas.includes(key))
      sug.push({ key, tipo: 'rec', i, min, med, texto: `${cfg.nomes[r.quem]}, dia ${r.dia}: nos últimos ${reais.length} pagamentos o menor valor foi ${brl(min)} e a média ${brl(med)}. Hoje está cadastrado ${brl(r.minimo)} (mínimo) e ${brl(r.medio)} (médio).` });
  });
  recs.forEach(r => {
    const pagas = lancs.filter(l => l.recorrenteId === r.id && l.pago).sort((a, b) => b.data.localeCompare(a.data)).slice(0, 3).map(l => l.valor);
    if (pagas.length < 2) return;
    const valor = emReais(media(pagas)), key = `conta:${r.id}:${valor}`;
    if (Math.abs(valor - r.valor) / r.valor > 0.1 && !dispensadas.includes(key))
      sug.push({ key, tipo: 'conta', id: r.id, valor, texto: `${r.desc}: a média das últimas ${pagas.length} contas pagas é ${brl(valor)}, e está cadastrada em ${brl(r.valor)}.` });
  });
  return sug;
}

// Quanto você costuma gastar por dia fora das contas fixas (últimos 30 dias)
function ritmoDeGasto(lancs) {
  const h = new Date(), h0 = new Date(h.getFullYear(), h.getMonth(), h.getDate());
  const limite = isoDe(new Date(h0.getFullYear(), h0.getMonth(), h0.getDate() - 30)), hojeI = isoDe(h0);
  const v = lancs.filter(l => l.tipo === 'despesa' && l.pago && !l.recorrenteId && !l.grupo && l.data >= limite && l.data <= hojeI);
  if (v.length < 5) return null;
  const dias = Math.min(30, 1 - diasAte(new Date(v.map(l => l.data).sort()[0] + 'T00:00:00')));
  if (dias < 7) return null;
  return { porDia: Math.round(v.reduce((t, l) => t + l.valor, 0) / dias), dias };
}

// "Posso comprar?": quando ou em quantas vezes a compra passa a caber
function extrasCompra(total, n, base) {
  if (n === 1) return [{ i: 0, valor: total }];
  const p0 = Math.floor(total / n);
  return Array.from({ length: n }, (_, k) => ({ i: Math.max(0, diasAte(somaMes(base, k))), valor: p0 + (k === 0 ? total - p0 * n : 0) }));
}
function primeiroDiaQueCabe(cfg, lancs, total, horizonte = 60) {
  for (let i0 = 1; i0 <= horizonte; i0++) {
    const c = projetarLongo(cfg, lancs, [{ i: i0, valor: total }]).curva;
    if (Math.min(...c.slice(i0)) >= cfg.margem) return i0; // só importa do dia da compra em diante
  }
  return null;
}
function menorParcelamento(cfg, lancs, total, base, de = 2) {
  for (let n = de; n <= 12; n++) if (Math.min(...projetarLongo(cfg, lancs, extrasCompra(total, n, base)).curva) >= cfg.margem) return n;
  return null;
}

/* ---------- Atalhos rápidos ---------- */
const telaAtual = () => document.querySelector('nav .ativa').dataset.tela;
// Lançamentos que você repete (2+ vezes nos últimos 90 dias), mais frequentes primeiro
function atalhosFrequentes(lancs) {
  const limite = isoDe(new Date(Date.now() - 90 * 864e5)), m = new Map();
  lancs.filter(l => l.pago && !l.recorrenteId && !l.grupo && !l.recebKey && l.data >= limite).sort((a, b) => a.data.localeCompare(b.data)).forEach(l => {
    const k = l.tipo + '|' + l.desc.trim().toLowerCase(), g = m.get(k) || { n: 0 };
    m.set(k, Object.assign(g, { n: g.n + 1, tipo: l.tipo, desc: l.desc, valor: l.valor, categoria: l.categoria || null, ult: l.data })); // o último valor usado vale
  });
  return [...m.values()].filter(g => g.n >= 2).sort((a, b) => b.n - a.n || b.ult.localeCompare(a.ult)).slice(0, 8);
}
function avisar(texto, acoes) {
  const antigo = document.querySelector('.toast'); if (antigo) antigo.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(texto)}</span>` + acoes.map((a, i) => `<button data-i="${i}">${a[0]}</button>`).join('');
  t.querySelectorAll('button').forEach(b => b.onclick = () => { t.remove(); acoes[+b.dataset.i][1](); });
  document.body.appendChild(t); setTimeout(() => t.remove(), 7000);
}
// Um toque: registra hoje, já pago, com o último valor e categoria; dá para desfazer ou editar
async function registrarAtalho(g) {
  const l = { tipo: g.tipo, desc: g.desc, valor: g.valor, data: hojeISO(), pago: true, pagoEm: Date.now(), categoria: g.tipo === 'despesa' ? g.categoria : null };
  l.id = await LANC.salvar(l);
  await mostrar(telaAtual());
  avisar(`${g.tipo === 'receita' ? 'Receita' : 'Despesa'} registrada: ${g.desc} · ${brl(g.valor)}`, [
    ['Desfazer', async () => { await LANC.apagar(l.id); mostrar(telaAtual()); }],
    ['Editar', () => abrirLancamento(l)]]);
}

/* ---------- Telas ---------- */
const area = document.getElementById('tela');

function formConfig(cfg, saldoAtual) {
  const c = cfg || { nomes: { eu: '', esposa: '' }, ...PADRAO };
  const linhas = c.recebimentos.map((r, i) => `
    <div class="bloco" data-i="${i}">
      <h3>Recebimento ${i + 1}</h3>
      <label>Quem recebe</label>
      <select class="quem"><option value="eu" ${r.quem === 'eu' ? 'selected' : ''}>Eu</option><option value="esposa" ${r.quem === 'esposa' ? 'selected' : ''}>Esposa</option></select>
      <label>Dia do mês</label>
      <input class="dia" type="number" inputmode="numeric" min="1" max="31" value="${r.dia}">
      <div class="duas">
        <div><label>Mínimo</label><input class="min" inputmode="numeric" placeholder="R$ 0,00" data-c="${r.minimo || ''}"></div>
        <div><label>Médio</label><input class="med" inputmode="numeric" placeholder="R$ 0,00" data-c="${r.medio || ''}"></div>
      </div>
    </div>`).join('');
  area.innerHTML = `
    <div class="form">
      <h2>${cfg ? 'Seus recebimentos' : 'Vamos configurar'}</h2>
      ${cfg && saldoAtual == null ? '<p class="aviso" style="margin-bottom:16px">Novidade: informe o saldo de hoje para o app calcular quanto você pode gastar.</p>' : ''}<p class="intro">O <b>mínimo</b> é o que costuma vir no pior caso. O <b>médio</b> é o valor típico. O app planeja com o mínimo.</p>
      <label>Seu nome</label><input id="nomeEu" value="${esc(c.nomes.eu)}" autocomplete="off">
      <label>Nome da sua esposa</label><input id="nomeEsposa" value="${esc(c.nomes.esposa)}" autocomplete="off">
      <label>Margem de segurança (o saldo não deve ficar abaixo disto)</label>
      <input id="margem" inputmode="numeric" data-c="${c.margem}">
      <label>Saldo de hoje (todas as contas e dinheiro somados)</label>
      <input id="saldo" inputmode="numeric" placeholder="R$ 0,00" data-c="${saldoAtual == null ? '' : saldoAtual}">
      ${linhas}
      <p class="erro" id="erro" role="alert"></p>
      <button class="botao" id="salvar">Salvar</button>
      ${cfg ? '<button class="botao sec" id="cancelar">Cancelar</button>' : ''}
    </div>`;
  area.querySelectorAll('input[data-c]').forEach(ligarDinheiro);
  document.getElementById('salvar').onclick = salvarConfig;
  const canc = document.getElementById('cancelar'); if (canc) canc.onclick = () => mostrar('hoje');
}

async function salvarConfig() {
  const erro = m => { document.getElementById('erro').textContent = m; };
  const eu = document.getElementById('nomeEu').value.trim();
  const esposa = document.getElementById('nomeEsposa').value.trim();
  if (!eu || !esposa) return erro('Preencha os dois nomes.');
  const recebimentos = [];
  for (const b of area.querySelectorAll('.bloco')) {
    const n = +b.dataset.i + 1;
    const dia = parseInt(b.querySelector('.dia').value, 10);
    const minimo = +(b.querySelector('.min').dataset.c || 0);
    const medio = +(b.querySelector('.med').dataset.c || 0);
    if (!(dia >= 1 && dia <= 31)) return erro(`Recebimento ${n}: o dia deve ficar entre 1 e 31.`);
    if (minimo <= 0 || medio <= 0) return erro(`Recebimento ${n}: informe o valor mínimo e o médio.`);
    if (minimo > medio) return erro(`Recebimento ${n}: o mínimo não pode ser maior que o médio.`);
    recebimentos.push({ quem: b.querySelector('.quem').value, dia, minimo, medio });
  }
  const margem = +(document.getElementById('margem').dataset.c || 0);
  const sRaw = document.getElementById('saldo').dataset.c;
  if (sRaw === undefined || sRaw === '') return erro('Informe o saldo de hoje (use R$ 0,00 se estiver zerado).');
  const antigo = await DB.ler('config'), lancs = await LANC.todos();
  let saldo = antigo && antigo.saldo, saldoEm = antigo && antigo.saldoEm;
  const novo = +sRaw;
  if (saldo === undefined || novo !== saldoDe(antigo, lancs)) { saldo = novo; saldoEm = Date.now(); } // só vira novo ponto de partida se você alterou o valor
  await DB.gravar('config', { nomes: { eu, esposa }, margem, recebimentos, saldo, saldoEm });
  mostrar('hoje');
}

let filtro = 'pendentes', mesFech = null, limiteContas = 15;
const telas = {
  async hoje() {
    const cfg = await DB.ler('config');
    if (!cfg) return formConfig(null);
    if (cfg.saldo === undefined) return formConfig(cfg, null);
    const lancs = await LANC.todos();
    const p = projetar(cfg, lancs), longo = projetarLongo(cfg, lancs, [], 30);
    const ub = await DB.ler('ultimoBackup'), semBackup = !ub || Date.now() - ub > 30 * 864e5;
    const ign = (await DB.ler('recebIgnorados')) || [], aConf = recebimentosAConfirmar(cfg, lancs, ign);
    const recs = (await DB.ler('recorrentes')) || [], disp = (await DB.ler('sugDispensadas')) || [];
    const sugs = sugestoesAjuste(cfg, lancs, recs, disp), ritmo = ritmoDeGasto(lancs), atalhos = atalhosFrequentes(lancs);
    const hojeI = hojeISO();
    const pend = lancs.filter(l => l.tipo === 'despesa' && !l.pago).sort((a, b) => a.data.localeCompare(b.data) || a.id - b.id);
    const noCiclo = pend.filter(l => Math.max(0, diasAte(new Date(l.data + 'T00:00:00'))) < p.dias);
    const sobra = p.saldoAtual - p.comprometido - cfg.margem, fim = p.fim.getDate();
    const [cls, rotulo] = sobra < 0 ? ['ruim', 'Sem folga hoje'] : longo.min < cfg.margem ? ['medio', 'Atenção nos próximos dias'] : ['ok', 'Tranquilo'];
    const apertoTxt = `Ponto mais baixo em 30 dias: <b>${brl(longo.min)}</b> em ${diaDoIndice(longo.iMin)}${longo.min < cfg.margem ? ', abaixo da margem' : ''}.`;
    const sub = sobra < 0 ? `Evite gastos até o dia ${fim}` : p.dias > 1 ? `por dia, até o dia ${fim} (${p.dias} dias)` : `até o dia ${fim}`;

    const confHtml = aConf.length ? `<div class="aviso-card"><b>Confirme o que chegou</b><p class="pequeno">Informe o valor real recebido para o saldo ficar certo.</p>${aConf.map((x, k) => `
      <div class="conf" data-i="${k}"><div class="confh">Dia ${x.d.getDate()} · ${esc(cfg.nomes[x.r.quem])}</div>
        <input class="cval" inputmode="numeric" data-c="${x.r.medio}">
        <div class="duas"><button class="botao" data-a="ok">Confirmar</button><button class="botao sec" data-a="ig">Ignorar</button></div></div>`).join('')}</div>` : '';
    const ritmoHtml = ritmo ? `<p class="pequeno" style="margin-top:2px">Seu ritmo recente: <b>${brl(ritmo.porDia)}</b>/dia${p.livre >= 0 ? (ritmo.porDia > p.livre ? ', acima do que cabe.' : ', dentro do que cabe.') : '.'}</p>` : '';
    const atalhosHtml = `<div class="atalhos"><button class="atalho fixo" id="nd">− Despesa</button><button class="atalho fixo" id="nr">+ Receita</button>${atalhos.map((g, k) => `<button class="atalho ${g.tipo}" data-i="${k}"><span>${esc(g.desc)}</span><b>${g.tipo === 'receita' ? '+ ' : ''}${brl(g.valor)}</b></button>`).join('')}</div>`;
    const venc = pend.slice(0, 3).map(l => `
      <div class="venc"><div class="d">${dataCurta(l.data)}</div>
        <div class="m">${esc(l.desc)}${l.data < hojeI ? '<span class="tag">atrasada</span>' : ''}</div>
        <div class="v">${brl(l.valor)}</div><button class="mini" data-id="${l.id}">Paguei</button></div>`).join('');
    const grupos = {}; const h = new Date();
    cfg.recebimentos.forEach(r => { const d = proximaData(r.dia, h), k = isoDe(d); (grupos[k] = grupos[k] || { d, itens: [] }).itens.push(r); });
    const receb = Object.values(grupos).sort((a, b) => a.d - b.d).slice(0, 3).map(g => {
      const n = diasAte(g.d), quando = n === 0 ? 'hoje' : n === 1 ? 'amanhã' : `em ${n} dias`;
      const nomes = [...new Set(g.itens.map(r => cfg.nomes[r.quem]))].join(' + ');
      return `<div><span>Dia ${g.d.getDate()} · ${quando}<br><small class="pequeno">${esc(nomes)}</small></span><span>${brl(g.itens.reduce((t, r) => t + r.minimo, 0))}</span></div>`;
    }).join('');

    area.innerHTML = `
      <h1>Olá, ${esc(cfg.nomes.eu)}</h1>${confHtml}
      <p class="contexto" style="margin:2px 0 0">Você pode gastar hoje</p>
      <div class="gigante m"><small>R$</small>${Math.floor(Math.max(p.livre, 0) / 100)}</div>
      <div class="linhachip"><span class="chip ${cls}">${rotulo}</span><span class="contexto">${sub}</span></div>
      ${ritmoHtml}${atalhosHtml}
      ${curvaHoje(longo.curva, cfg.margem, marcosRecebimento(cfg, 30), longo.iMin)}
      <p class="contexto" style="font-size:15px;margin-bottom:0">${apertoTxt}</p>
      <div class="sec-t" style="margin-top:22px">Vence em breve</div>
      ${venc || '<p class="contexto">Nenhuma conta pendente.</p>'}
      ${pend.length > 3 ? `<button class="linkrow" id="todas"><span>Ver todas as pendentes (${pend.length})</span><span>›</span></button>` : ''}
      <details class="det" style="margin-top:14px"><summary>Como chegamos nesse número</summary><div class="corpo extrato">
        <div><span>Saldo hoje</span><span>${brl(p.saldoAtual)}</span></div>
        <div class="menos"><span>Contas até o dia ${fim} (${noCiclo.length})</span><span>− ${brl(p.comprometido)}</span></div>
        <div class="menos"><span>Margem de segurança</span><span>− ${brl(cfg.margem)}</span></div>
        <div class="tot"><span>${sobra >= 0 ? 'Sobra' : 'Falta'}</span><span class="${sobra >= 0 ? 'pos' : 'neg'}">${brl(Math.abs(sobra))}</span></div></div></details>
      ${sugs.length ? `<details class="det sugd" open><summary>Sugestões do Folga (${sugs.length})</summary><div class="corpo">${sugs.map((x, k) => `
        <div class="sugestao" data-i="${k}"><p>${esc(x.texto)}</p><div class="duas"><button class="botao" data-a="aceitar">Atualizar</button><button class="botao sec" data-a="dispensar">Dispensar</button></div></div>`).join('')}</div></details>` : ''}
      <details class="det"><summary>Próximos recebimentos (valor mínimo)</summary><div class="corpo lista" style="margin-top:0">${receb}</div></details>
      <details class="det"><summary>Mais${semBackup ? ' <b class="tag">backup pendente</b>' : ''}</summary><div class="corpo">
        <button class="linkrow" id="fech"><span>Fechamento do mês</span><span>›</span></button>
        <button class="linkrow" id="lemb"><span>Lembretes no Calendário</span><span>›</span></button>
        <button class="linkrow" id="bkp"><span>Backup e restauração${semBackup ? '<b class="tag">fazer agora</b>' : ''}</span><span>›</span></button>
        <button class="linkrow" id="editar"><span>Editar recebimentos e saldo</span><span>›</span></button></div></details>`;

    area.querySelector('#nd').onclick = () => abrirLancamento(null, 'despesa');
    area.querySelector('#nr').onclick = () => abrirLancamento(null, 'receita');
    area.querySelectorAll('.atalho[data-i]').forEach(b => b.onclick = () => registrarAtalho(atalhos[+b.dataset.i]));
    area.querySelectorAll('.mini').forEach(b => b.onclick = async () => {
      const l = pend.find(x => x.id === +b.dataset.id); l.pago = true; l.pagoEm = Date.now();
      await LANC.salvar(l); mostrar('hoje');
    });
    const todas = area.querySelector('#todas'); if (todas) todas.onclick = () => { filtro = 'pendentes'; mostrar('contas'); };
    area.querySelector('#fech').onclick = () => { mesFech = null; mostrar('fechamento'); };
    area.querySelector('#bkp').onclick = () => mostrar('backup');
    area.querySelector('#lemb').onclick = () => mostrar('lembretes');
    area.querySelector('#editar').onclick = () => formConfig(cfg, p.saldoAtual);
    area.querySelectorAll('.conf').forEach(el => {
      const x = aConf[+el.dataset.i], campo = el.querySelector('.cval'); ligarDinheiro(campo);
      el.querySelector('[data-a=ok]').onclick = async () => {
        const valor = +(campo.dataset.c || 0);
        if (valor <= 0) return alert('Informe um valor maior que zero.');
        await LANC.salvar({ tipo: 'receita', desc: 'Salário ' + cfg.nomes[x.r.quem], valor, data: isoDe(x.d), pago: true, pagoEm: Date.now(), categoria: null, recebKey: x.key });
        mostrar('hoje');
      };
      el.querySelector('[data-a=ig]').onclick = async () => {
        if (!confirm('Ignorar este recebimento? Ele não será contado no saldo nem no fechamento.')) return;
        await DB.gravar('recebIgnorados', [...ign, x.key]); mostrar('hoje');
      };
    });
    area.querySelectorAll('.sugestao').forEach(el => {
      const x = sugs[+el.dataset.i];
      el.querySelector('[data-a=dispensar]').onclick = async () => { await DB.gravar('sugDispensadas', [...disp, x.key]); mostrar('hoje'); };
      el.querySelector('[data-a=aceitar]').onclick = async () => {
        if (x.tipo === 'rec') { cfg.recebimentos[x.i].minimo = x.min; cfg.recebimentos[x.i].medio = x.med; await DB.gravar('config', cfg); }
        else {
          const lista = (await DB.ler('recorrentes')) || [], r = lista.find(y => y.id === x.id); r.valor = x.valor; await DB.gravar('recorrentes', lista);
          for (const y of lancs.filter(z => z.recorrenteId === x.id && !z.pago && z.data >= hojeI)) { y.valor = x.valor; await LANC.salvar(y); }
        }
        mostrar('hoje');
      };
    });
  },
  async lembretes() {
    const cfg = await DB.ler('config'), lancs = await LANC.todos();
    const { nC, nR } = gerarICS(cfg, lancs);
    area.innerHTML = `<div class="form"><h2>Lembretes no Calendário</h2>
      <p class="intro">O iPhone não deixa um app instalado pelo Safari agendar notificações sozinho. A solução sem servidor é criar eventos com alarme no app Calendário, que avisa mesmo com o Folga fechado.</p>
      <p class="contexto">Serão criados <b>${nC}</b> lembretes de contas (véspera às 9h e no dia às 9h) e <b>${nR}</b> avisos "Confirmar recebimento" (às 18h do dia do pagamento).</p>
      <button class="botao" id="gerar">Gerar lembretes</button>
      <p class="pequeno" style="margin-top:18px"><b>Como usar</b><br>1. No app Calendário, crie um calendário chamado Folga.<br>2. Toque em Gerar lembretes e salve ou abra o arquivo.<br>3. Abra o arquivo e toque em Adicionar tudo, escolhendo o calendário Folga.<br>4. Para atualizar (contas novas ou já pagas), apague o calendário Folga, crie de novo e gere outro arquivo.</p>
      <p id="msg" role="status"></p><button class="botao sec" id="voltar" style="margin-top:20px">Voltar</button></div>`;
    area.querySelector('#voltar').onclick = () => mostrar('hoje');
    area.querySelector('#gerar').onclick = async () => {
      const arq = new File([gerarICS(cfg, await LANC.todos()).texto], 'folga-lembretes.ics', { type: 'text/calendar' }), m = area.querySelector('#msg');
      try {
        if (navigator.canShare && navigator.canShare({ files: [arq] })) await navigator.share({ files: [arq], title: 'Lembretes Folga' });
        else { const url = URL.createObjectURL(arq), a = document.createElement('a'); a.href = url; a.download = arq.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
        m.className = 'ok'; m.textContent = 'Arquivo gerado. Abra-o e toque em Adicionar tudo.';
      } catch (e) { m.className = 'erro'; m.textContent = e.name === 'AbortError' ? 'Cancelado.' : 'Não foi possível gerar o arquivo.'; }
    };
  },
  async recorrentes() {
    const lista = (await DB.ler('recorrentes')) || [];
    const itens = lista.map(r => { const p = proximaOcorrencia(r); return `
      <div class="item" data-id="${r.id}"><div><div class="data">${FREQ[r.freq]} · próximo ${dataCurta(isoDe(p))}</div><div class="desc">${esc(r.desc)}</div></div>
        <div><div class="val desp">${brl(r.valor)}</div><div class="acoes"><button data-a="ed">Editar</button><button data-a="del">Excluir</button></div></div></div>`; }).join('');
    area.innerHTML = `<h1>Contas recorrentes</h1>
      <button class="botao" id="nova" style="margin:14px 0 6px">Nova recorrente</button>
      ${itens || '<p class="contexto" style="margin-top:20px">Nenhuma ainda. Cadastre aluguel, internet, assinaturas e outras contas que se repetem.</p>'}
      <button class="botao sec" id="voltar" style="margin-top:20px">Voltar para Contas</button>`;
    area.querySelector('#nova').onclick = () => formRec(null);
    area.querySelector('#voltar').onclick = () => mostrar('contas');
    area.querySelectorAll('.item').forEach(el => {
      const r = lista.find(x => x.id === +el.dataset.id);
      el.querySelector('[data-a=ed]').onclick = () => formRec(r);
      el.querySelector('[data-a=del]').onclick = async () => {
        if (!confirm('Excluir "' + r.desc + '" e os próximos lançamentos pendentes dela?')) return;
        await limparFuturos(r);
        await DB.gravar('recorrentes', lista.filter(x => x.id !== r.id));
        mostrar('recorrentes');
      };
    });
  },
  async backup() {
    const ub = await DB.ler('ultimoBackup');
    area.innerHTML = `<div class="form"><h2>Backup</h2>
      <p class="intro">Seus dados ficam só neste iPhone. Se o app for removido ou os dados do Safari forem apagados, eles se perdem. O backup é um arquivo que você guarda no app Arquivos ou no iCloud.</p>
      <p class="pequeno">${ub ? 'Último backup: ' + new Date(ub).toLocaleDateString('pt-BR') : 'Você ainda não fez nenhum backup.'}</p>
      <button class="botao" id="exp" style="margin-top:16px">Exportar backup</button>
      <label class="botao" for="arq">Restaurar de um arquivo</label><input type="file" id="arq" accept=".json,application/json">
      <p id="msg" role="status"></p>
      <button class="botao sec" id="voltar" style="margin-top:24px">Voltar</button></div>`;
    const msg = (t, erro) => { const m = area.querySelector('#msg'); m.className = erro ? 'erro' : 'ok'; m.textContent = t; };
    area.querySelector('#exp').onclick = () => exportarBackup(msg);
    area.querySelector('#arq').onchange = e => { if (e.target.files[0]) restaurarBackup(e.target.files[0], msg); e.target.value = ''; };
    area.querySelector('#voltar').onclick = () => mostrar('hoje');
  },
  async fechamento() {
    const cfg = await DB.ler('config'), lancs = await LANC.todos();
    if (!cfg || cfg.saldo === undefined) { area.innerHTML = '<div class="vazio"><h1>Fechamento do mês</h1><p>Termine a configuração na aba Hoje primeiro.</p></div>'; return; }
    const atualYM = ymDe(new Date());
    const minYM = [ymDe(new Date(cfg.saldoEm)), ...lancs.map(l => l.data.slice(0, 7))].sort()[0];
    const ym = mesFech || atualYM, [y, m] = ym.split('-').map(Number);
    const ign = (await DB.ler('recebIgnorados')) || [];
    const r = resumoMes(cfg, lancs, ym, ign), ant = resumoMes(cfg, lancs, ymDe(new Date(y, m - 2, 1)), ign);
    const nomeMes = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const dif = r.saldo - ant.saldo;
    const max = r.cats.length ? r.cats[0][1] : 1;
    const corpo = !r.temDados ? '<p class="contexto">Sem movimentações neste mês.</p>' : `
      <p class="contexto" style="margin-bottom:0">${ym === atualYM ? 'Mês em andamento · ' : ''}Resultado do mês</p>
      <div class="gigante ${r.saldo >= 0 ? 'pos' : 'neg'}" style="font-size:48px">${brl(r.saldo)}</div>
      <div class="lista">
        <div><span>Salários previstos (valor médio)</span><span>${brl(r.fixos)}</span></div>
        <div><span>Receitas recebidas (inclui salários confirmados)</span><span>${brl(r.rec)}</span></div>
        <div><span>Despesas pagas (${r.nPagas})</span><span>${brl(r.pagas)}</span></div>
        <div><span>Despesas pendentes (${r.nPend})</span><span>${brl(r.pend)}</span></div>
      </div>
      ${r.cats.length ? `<p class="contexto" style="margin-top:22px">Maior categoria de gasto: <b>${esc(r.cats[0][0])}</b> (${brl(r.cats[0][1])})</p>` +
        r.cats.slice(0, 6).map(([c, v]) => `<div class="cat"><div class="topo"><span>${esc(c)}</span><span>${brl(v)}</span></div><div class="barra" style="width:${Math.max(3, Math.round(v / max * 100))}%"></div></div>`).join('') : ''}
      ${ant.temDados ? `<p class="aviso" style="margin-top:22px">${dif >= 0 ? 'Seu saldo aumentou ' + brl(dif) : 'Seu saldo ficou ' + brl(-dif) + ' menor'} em relação ao mês anterior.</p>` : ''}
      <p class="pequeno" style="margin-top:14px">Gastos por categoria somam despesas pagas e pendentes do mês. Salários ainda não confirmados entram pelo valor médio.</p>`;
    area.innerHTML = `<h1>Fechamento do mês</h1>
      <div class="mesnav"><button id="ant" aria-label="Mês anterior" ${ym <= minYM ? 'disabled' : ''}>‹</button><span>${nomeMes}</span><button id="prox" aria-label="Próximo mês" ${ym >= atualYM ? 'disabled' : ''}>›</button></div>
      ${corpo}<button class="botao sec" id="voltar" style="margin-top:24px">Voltar</button>`;
    area.querySelector('#ant').onclick = () => { mesFech = ymDe(new Date(y, m - 2, 1)); mostrar('fechamento'); };
    area.querySelector('#prox').onclick = () => { mesFech = ymDe(new Date(y, m, 1)); mostrar('fechamento'); };
    area.querySelector('#voltar').onclick = () => { mesFech = null; mostrar('hoje'); };
  },
  async comprar() {
    const cfg = await DB.ler('config');
    if (!cfg || cfg.saldo === undefined) { area.innerHTML = '<div class="vazio"><h1>Posso comprar?</h1><p>Termine a configuração na aba Hoje primeiro.</p></div>'; return; }
    const lancs = await LANC.todos();
    const opcoes = Array.from({ length: 12 }, (_, k) => `<option value="${k + 1}">${k ? (k + 1) + 'x' : 'À vista (sai hoje)'}</option>`).join('');
    area.innerHTML = `<div class="form"><h1>Posso comprar?</h1>
      <label>Valor total</label><input id="cv" class="valorgrande" inputmode="numeric" placeholder="R$ 0,00">
      <label>Em quantas vezes</label><select id="cn">${opcoes}</select>
      <div id="cdata" style="display:none"><label>Vencimento da 1ª parcela</label><input id="cd" type="date" value="${isoDe(somaMes(new Date(), 1))}"></div>
      <label>O que é? (para registrar)</label><input id="cdesc" autocomplete="off" placeholder="Ex.: Celular">
      <div id="res"></div></div>`;
    const $ = id => area.querySelector('#' + id);
    ligarDinheiro($('cv'));
    let atual = null;
    const atualizar = () => {
      const total = +($('cv').dataset.c || 0), n = +$('cn').value;
      $('cdata').style.display = n > 1 ? '' : 'none';
      atual = null;
      if (total <= 0) { $('res').innerHTML = '<p class="pequeno" style="margin-top:20px">Digite o valor para ver o impacto nos próximos 90 dias.</p>'; return; }
      let extras, base = null;
      if (n === 1) extras = [{ i: 0, valor: total }];
      else {
        base = new Date($('cd').value + 'T00:00:00');
        if (isNaN(base)) { $('res').innerHTML = '<p class="erro">Escolha uma data válida para a 1ª parcela.</p>'; return; }
        const p0 = Math.floor(total / n);
        extras = Array.from({ length: n }, (_, k) => ({ i: Math.max(0, diasAte(somaMes(base, k))), valor: p0 + (k === 0 ? total - p0 * n : 0) }));
      }
      atual = { total, n, extras, base };
      const sem = projetarLongo(cfg, lancs), com = projetarLongo(cfg, lancs, extras);
      const l0 = projetar(cfg, lancs).livre, l1 = projetar(cfg, lancs, extras).livre;
      let cls, titulo, motivo;
      if (com.min < 0) { cls = 'v-ruim'; titulo = 'Não cabe'; motivo = `No dia ${diaDoIndice(com.iMin)} o saldo fica negativo (${brl(com.min)}).`; }
      else if (com.min < cfg.margem) { cls = 'v-medio'; titulo = 'Cabe, mas aperta'; motivo = `No dia ${diaDoIndice(com.iMin)} o saldo cai para ${brl(com.min)}, abaixo da sua margem de ${brl(cfg.margem)}.${sem.min < cfg.margem ? ' Esse período já estava apertado antes da compra.' : ''}`; }
      else { cls = 'v-ok'; titulo = 'Cabe'; motivo = `O saldo não passa da sua margem nos próximos 90 dias. O ponto mais baixo é ${brl(com.min)}, no dia ${diaDoIndice(com.iMin)}.`; }
      let sugHtml = '';
      if (cls !== 'v-ok') {
        const sg = [], b1 = base || somaMes(new Date(), 1);
        if (n === 1) { const d0 = primeiroDiaQueCabe(cfg, lancs, total); if (d0) sg.push(`Esperar até ${diaDoIndice(d0)}: à vista, a compra passa a caber.`); }
        const nm = menorParcelamento(cfg, lancs, total, b1, n + 1);
        if (nm) sg.push(`Parcelar em ${nm}x, com a 1ª parcela em ${dataCurta(isoDe(b1))}: cabe.`);
        if (sg.length) sugHtml = `<p class="aviso" style="margin:12px 0"><b>Sugestão</b><br>${sg.join('<br>')}</p>`;
      }
      $('res').innerHTML = `<div class="veredito ${cls}">${titulo}</div><p class="contexto" style="margin-bottom:12px">${motivo}</p>${sugHtml}
        ${curvaDupla(sem.curva, com.curva, cfg.margem)}
        <p class="pequeno">Tracejado: sem a compra · Linha cheia: com a compra.</p>
        <p class="contexto" style="margin-top:14px">Livre por dia até o próximo recebimento: <b>${brl(Math.max(l0, 0))}</b> → <b>${brl(Math.max(l1, 0))}</b></p>
        <p class="pequeno">Considera só as contas que você já lançou e os recebimentos pelo valor mínimo. Contas fixas futuras ainda não lançadas não entram.</p>
        <p class="erro" id="cerr" role="alert"></p>
        <button class="botao" id="creg">Registrar compra</button><button class="botao sec" id="cdes">Desistir</button>`;
      $('cdes').onclick = () => mostrar('comprar');
      $('creg').onclick = async () => {
        const desc = $('cdesc').value.trim();
        if (!desc) return $('cerr').textContent = 'Informe o que é a compra, no campo acima, para registrar.';
        if (n === 1) await LANC.salvar({ tipo: 'despesa', categoria: 'Compras', desc, valor: total, data: hojeISO(), pago: true, pagoEm: Date.now() });
        else { const grupo = Date.now(); for (let k = 0; k < n; k++) await LANC.salvar({ tipo: 'despesa', categoria: 'Compras', desc: `${desc} (${k + 1}/${n})`, valor: extras[k].valor, data: isoDe(somaMes(base, k)), pago: false, pagoEm: null, grupo, parcela: k + 1, total: n }); }
        if (n > 1) filtro = 'pendentes';
        mostrar(n === 1 ? 'hoje' : 'contas');
      };
    };
    ['input', 'change'].forEach(ev => area.querySelector('.form').addEventListener(ev, e => { if (e.target.id !== 'cdesc') atualizar(); }));
    atualizar();
  },
  async contas() {
    const todos = (await LANC.todos()).sort((a, b) => a.data.localeCompare(b.data) || a.id - b.id);
    const vis = filtro === 'pendentes' ? todos.filter(l => !l.pago) : todos;
    const MES = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); };
    let mesAtual = '';
    const itens = vis.slice(0, limiteContas).map(l => {
      const cab = l.data.slice(0, 7) !== mesAtual ? `<div class="sec-t" style="margin-top:22px;text-transform:capitalize">${MES(mesAtual = l.data.slice(0, 7))}</div>` : '';
      const sub = [l.categoria, l.pago ? '' : (l.data < hojeISO() ? 'atrasada' : 'pendente')].filter(Boolean).map(esc).join(' · ');
      return cab + `<div class="cv ${l.pago ? 'paga' : ''}" data-id="${l.id}"><div class="l1"><span class="data">${dataCurta(l.data)}</span><span class="desc">${esc(l.desc)}</span><span class="val ${l.tipo === 'receita' ? 'rec' : ''}">${l.tipo === 'receita' ? '+ ' : '− '}${brl(l.valor)}</span></div>${sub ? `<div class="sub">${sub}</div>` : ''}
        <div class="acoes"><button class="pagar" data-a="alt">${l.pago ? 'Desfazer' : (l.tipo === 'receita' ? 'Recebi' : 'Paguei')}</button><button data-a="ed">Editar</button><button data-a="del">Excluir</button></div></div>`;
    }).join('');
    const maisBtn = vis.length > limiteContas ? `<button class="botao sec" id="mais" style="margin-top:16px">Mostrar mais (${vis.length - limiteContas})</button>` : '';
    area.innerHTML = `<h1>Contas</h1>
      <button class="botao sec" id="rec" style="margin-top:12px">Contas recorrentes</button>
      <div class="filtros"><button data-f="pendentes" class="${filtro === 'pendentes' ? 'on' : ''}">Pendentes</button><button data-f="todos" class="${filtro === 'todos' ? 'on' : ''}">Todas</button></div>
      ${itens ? '<p class="pequeno" style="margin:6px 0 0">Toque numa conta para pagar, editar ou excluir.</p>' : ''}${itens || '<p class="contexto" style="margin-top:24px">Nada por aqui. Toque no + para lançar.</p>'}${maisBtn}`;
    area.querySelector('#rec').onclick = () => mostrar('recorrentes');
    area.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filtro = b.dataset.f; limiteContas = 15; mostrar('contas'); });
    const mais = area.querySelector('#mais');
    if (mais) mais.onclick = async () => { const y = area.scrollTop; limiteContas += 15; await mostrar('contas'); area.scrollTop = y; };
    area.querySelectorAll('.cv').forEach(el => {
      el.addEventListener('click', e => { if (!e.target.closest('button')) el.classList.toggle('aberto'); });
      const l = todos.find(x => x.id === +el.dataset.id);
      el.querySelector('[data-a=ed]').onclick = () => abrirLancamento(l);
      el.querySelector('[data-a=alt]').onclick = async () => { l.pago = !l.pago; l.pagoEm = l.pago ? Date.now() : null; await LANC.salvar(l); mostrar('contas'); };
      el.querySelector('[data-a=del]').onclick = async () => { if (confirm('Excluir "' + l.desc + '"?')) { await LANC.apagar(l.id); mostrar('contas'); } };
    });
  }
};

async function abrirLancamento(edit, tipoInicial) {
  if (!(edit && typeof edit.id === 'number')) edit = null; // só edita se receber um lançamento de verdade (não um toque)
  const todos = await LANC.todos(), sug = [...new Set(todos.map(l => l.desc))];
  const hist = {}; // o que o app já aprendeu sobre cada descrição
  todos.filter(l => l.tipo === 'despesa' && l.categoria).sort((a, b) => a.data.localeCompare(b.data)).forEach(l => {
    const h = hist[l.desc.trim().toLowerCase()] = hist[l.desc.trim().toLowerCase()] || { cats: {}, valores: [] };
    h.cats[l.categoria] = (h.cats[l.categoria] || 0) + 1; h.valores.push(l.valor);
  });
  const ultima = await DB.ler('ultimaCategoria');
  let tipo = edit ? edit.tipo : (tipoInicial || 'despesa'), pago = edit ? edit.pago : true;
  const f = document.createElement('div'); f.className = 'folha';
  f.innerHTML = `<div class="painel form">
    ${edit ? '<h2>Editar lançamento</h2>' : ''}
    <div class="seg" id="sTipo"><button data-v="despesa">Despesa</button><button data-v="receita">Receita</button></div>
    <label>Valor</label><input id="lv" class="valorgrande" inputmode="numeric" placeholder="R$ 0,00" ${edit ? `data-c="${edit.valor}"` : ''}>
    <div id="ldica" style="display:flex;gap:8px;margin-top:8px"></div>
    <label>Descrição</label><input id="ld" list="sug" autocomplete="off" placeholder="Ex.: Mercado" value="${edit ? esc(edit.desc) : ''}"><datalist id="sug">${sug.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    <div id="lcatw"><label>Categoria</label><select id="lcat">${opcoesCat(edit ? (edit.categoria || 'Outros') : (ultima || 'Outros'))}</select></div>
    <label>Data</label><input id="ldt" type="date" value="${edit ? edit.data : hojeISO()}">
    <label>Situação</label><div class="seg" id="sPago"><button data-v="1"></button><button data-v="0">Pendente</button></div>
    <p class="erro" id="le" role="alert"></p>
    <button class="botao" id="ls">Salvar</button><button class="botao sec" id="lc">Cancelar</button></div>`;
  document.body.appendChild(f);
  const $ = id => f.querySelector('#' + id);
  const pintar = () => {
    f.querySelector('#lcatw').style.display = tipo === 'despesa' ? '' : 'none';
    f.querySelectorAll('#sTipo button').forEach(b => b.classList.toggle('on', b.dataset.v === tipo));
    f.querySelector('#sPago button[data-v="1"]').textContent = tipo === 'receita' ? 'Recebido' : 'Pago';
    f.querySelectorAll('#sPago button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === pago));
  };
  f.querySelectorAll('#sTipo button').forEach(b => b.onclick = () => { tipo = b.dataset.v; pintar(); });
  f.querySelectorAll('#sPago button').forEach(b => b.onclick = () => { pago = b.dataset.v === '1'; pintar(); });
  pintar(); ligarDinheiro($('lv')); $('lv').focus();
  const sugerir = () => {
    const dica = $('ldica'), h = hist[$('ld').value.trim().toLowerCase()];
    dica.innerHTML = '';
    if (edit || tipo !== 'despesa' || !h) return;
    $('lcat').value = Object.entries(h.cats).sort((a, b) => b[1] - a[1])[0][0]; // categoria mais usada nessa descrição
    if (+($('lv').dataset.c || 0)) return;
    const ult = h.valores[h.valores.length - 1], med = emReais(media(h.valores.slice(-5)));
    dica.innerHTML = `<button class="mini" data-v="${ult}">Último: ${brl(ult)}</button>` + (med !== ult ? `<button class="mini" data-v="${med}">Média: ${brl(med)}</button>` : '');
    dica.querySelectorAll('button').forEach(b => b.onclick = () => { $('lv').dataset.c = b.dataset.v; $('lv').value = brl(+b.dataset.v); dica.innerHTML = ''; });
  };
  $('ld').addEventListener('input', sugerir); $('ld').addEventListener('change', sugerir);
  const fechar = () => f.remove();
  $('lc').onclick = fechar;
  f.addEventListener('click', e => { if (e.target === f) fechar(); });
  $('ls').onclick = async () => {
    const valor = +($('lv').dataset.c || 0), desc = $('ld').value.trim(), data = $('ldt').value;
    if (valor <= 0) return $('le').textContent = 'Informe um valor maior que zero.';
    if (!desc) return $('le').textContent = 'Informe uma descrição.';
    if (!data || isNaN(new Date(data + 'T00:00:00'))) return $('le').textContent = 'Escolha uma data válida.';
    const cat = tipo === 'despesa' ? f.querySelector('#lcat').value : null;
    if (cat) await DB.gravar('ultimaCategoria', cat);
    // Ao editar, mantém o vínculo com a recorrente/parcelas e só marca "pago agora" se passou de pendente para pago.
    await LANC.salvar({ ...(edit || {}), tipo, desc, valor, data, pago, categoria: cat, pagoEm: pago ? (edit && edit.pago ? (edit.pagoEm ?? null) : Date.now()) : null });
    fechar(); mostrar(document.querySelector('nav .ativa').dataset.tela);
  };
}
const fab = document.createElement('button'); fab.className = 'fab'; fab.textContent = '+'; fab.setAttribute('aria-label', 'Novo lançamento');
fab.onclick = () => abrirLancamento(); document.body.appendChild(fab);

async function mostrar(nome) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativa', b.dataset.tela === (nome === 'recorrentes' ? 'contas' : ['backup', 'fechamento', 'lembretes'].includes(nome) ? 'hoje' : nome)));
  await telas[nome]();
  area.scrollTop = 0;
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => mostrar(b.dataset.tela)));
gerarRecorrentes().catch(() => {}).then(() => mostrar('hoje'));

if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); // pede ao iOS para não apagar os dados
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
