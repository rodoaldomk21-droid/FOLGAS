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
  return null;
}

async function exportarBackup(msg) {
  const cfg = await DB.ler('config');
  if (!cfg || cfg.saldo === undefined) return msg('Termine a configuração na aba Hoje antes de fazer backup.', true);
  const dados = { app: 'folga', versao: 1, exportadoEm: new Date().toISOString(), config: cfg, recorrentes: (await DB.ler('recorrentes')) || [], lancamentos: await LANC.todos() };
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
  const campos = ['id', 'tipo', 'desc', 'valor', 'data', 'pago', 'pagoEm', 'recorrenteId', 'categoria', 'grupo', 'parcela', 'total'];
  const limpos = b.lancamentos.map(l => Object.fromEntries(campos.filter(k => l[k] !== undefined).map(k => [k, l[k]])));
  const d = await DB.abrir();
  try {
    await new Promise((ok, falha) => { // tudo ou nada: se algo falhar, os dados atuais ficam intactos
      const t = d.transaction(['config', 'lancamentos'], 'readwrite'), c = t.objectStore('config'), l = t.objectStore('lancamentos');
      l.clear(); c.put(b.config, 'config'); c.put(b.recorrentes, 'recorrentes'); limpos.forEach(x => l.put(x));
      t.oncomplete = ok; t.onerror = t.onabort = () => falha(t.error);
    });
  } catch { return msg('Falha ao restaurar. Seus dados atuais foram mantidos.', true); }
  await gerarRecorrentes();
  mostrar('hoje');
}

/* ---------- Fechamento do mês ---------- */
const ymDe = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
// Receitas = salários fixos pelo valor MÉDIO (ainda não há confirmação do valor real) + receitas lançadas e recebidas.
function resumoMes(cfg, lancs, ym) {
  const ini = new Date(cfg.saldoEm), iniYM = ymDe(ini);
  const doMes = lancs.filter(l => l.data.startsWith(ym));
  const fixos = cfg.recebimentos.filter(r => ym > iniYM || (ym === iniYM && r.dia >= ini.getDate())).reduce((t, r) => t + r.medio, 0);
  const soma = a => a.reduce((t, l) => t + l.valor, 0);
  const rec = soma(doMes.filter(l => l.tipo === 'receita' && l.pago));
  const desp = doMes.filter(l => l.tipo === 'despesa'), pagas = desp.filter(l => l.pago), pend = desp.filter(l => !l.pago);
  const porCat = {}; desp.forEach(l => { const c = l.categoria || 'Sem categoria'; porCat[c] = (porCat[c] || 0) + l.valor; });
  return { temDados: doMes.length > 0, fixos, rec, pagas: soma(pagas), nPagas: pagas.length, pend: soma(pend), nPend: pend.length,
           saldo: ym < iniYM ? -soma(pagas) + rec : fixos + rec - soma(pagas), cats: Object.entries(porCat).sort((a, b) => b[1] - a[1]) };
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

let filtro = 'pendentes', mesFech = null;
const telas = {
  async hoje() {
    const cfg = await DB.ler('config');
    if (!cfg) return formConfig(null);
    if (cfg.saldo === undefined) return formConfig(cfg, null);
    const lancs = await LANC.todos();
    const p = projetar(cfg, lancs);
    const ub = await DB.ler('ultimoBackup');
    const velho = !ub || Date.now() - ub > 30 * 864e5;
    const pend = lancs.filter(l => l.tipo === 'despesa' && !l.pago);
    const totalPend = pend.reduce((t, l) => t + l.valor, 0);
    const hoje = new Date();
    const lista = cfg.recebimentos
      .map(r => ({ ...r, data: proximaData(r.dia, hoje) }))
      .sort((a, b) => a.data - b.data)
      .map(r => {
        const dias = Math.round((r.data - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 864e5);
        const quando = dias === 0 ? 'hoje' : dias === 1 ? 'amanhã' : `em ${dias} dias`;
        return `<div><span>Dia ${r.data.getDate()} · ${esc(cfg.nomes[r.quem])}</span><span>${brl(r.minimo)}<br>${quando}</span></div>`;
      }).join('');
    const falta = p.livre < 0;
    const ctx = falta
      ? `Faltam ${brl(-p.livre * p.dias)} para cobrir as contas e a margem até o dia ${p.fim.getDate()}.`
      : `Até o dia ${p.fim.getDate()} (${p.dias} ${p.dias === 1 ? 'dia' : 'dias'}). Saldo hoje: ${brl(p.saldoAtual)}.`;
    const apertoTxt = p.aperto.valor < cfg.margem
      ? `Dia ${p.aperto.dia} é o mais apertado: o saldo cai para ${brl(p.aperto.valor)}, abaixo da sua margem.`
      : `Dia ${p.aperto.dia} é o mais apertado: sobram ${brl(p.aperto.valor)}.`;
    area.innerHTML = `
      <h1>Olá, ${esc(cfg.nomes.eu)}. Hoje você pode gastar</h1>
      <div class="gigante"><small>R$</small>${Math.floor(Math.max(p.livre, 0) / 100)}</div>
      <p class="contexto ${falta ? 'alerta' : ''}">${ctx}</p>
      ${curvaSVG(p.curva, cfg.margem)}
      <p class="contexto">${apertoTxt}</p>
      <p class="aviso">Contas pendentes: <b>${pend.length}</b> · ${brl(totalPend)}. O cálculo usa o valor mínimo dos recebimentos.</p>
      <div class="lista"><h1>Próximos recebimentos (valor mínimo)</h1>${lista}</div>
      ${velho ? `<p class="aviso" style="margin-top:20px">${ub ? 'Seu último backup tem mais de 30 dias.' : 'Você ainda não fez backup.'} Faça um para não perder seus dados.</p>` : ''}
      <button class="botao sec" id="editar" style="margin-top:24px">Editar recebimentos e saldo</button>
      <button class="botao sec" id="fech">Fechamento do mês</button>
      <button class="botao sec" id="bkp">Backup e restauração</button>`;
    document.getElementById('fech').onclick = () => { mesFech = null; mostrar('fechamento'); };
    document.getElementById('bkp').onclick = () => mostrar('backup');
    document.getElementById('editar').onclick = () => formConfig(cfg, p.saldoAtual);
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
    const r = resumoMes(cfg, lancs, ym), ant = resumoMes(cfg, lancs, ymDe(new Date(y, m - 2, 1)));
    const nomeMes = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const dif = r.saldo - ant.saldo;
    const max = r.cats.length ? r.cats[0][1] : 1;
    const corpo = !r.temDados ? '<p class="contexto">Sem movimentações neste mês.</p>' : `
      <p class="contexto" style="margin-bottom:0">${ym === atualYM ? 'Mês em andamento · ' : ''}Resultado do mês</p>
      <div class="gigante ${r.saldo >= 0 ? 'pos' : 'neg'}" style="font-size:48px">${brl(r.saldo)}</div>
      <div class="lista">
        <div><span>Salários (valor médio cadastrado)</span><span>${brl(r.fixos)}</span></div>
        <div><span>Outras receitas recebidas</span><span>${brl(r.rec)}</span></div>
        <div><span>Despesas pagas (${r.nPagas})</span><span>${brl(r.pagas)}</span></div>
        <div><span>Despesas pendentes (${r.nPend})</span><span>${brl(r.pend)}</span></div>
      </div>
      ${r.cats.length ? `<p class="contexto" style="margin-top:22px">Maior categoria de gasto: <b>${esc(r.cats[0][0])}</b> (${brl(r.cats[0][1])})</p>` +
        r.cats.slice(0, 6).map(([c, v]) => `<div class="cat"><div class="topo"><span>${esc(c)}</span><span>${brl(v)}</span></div><div class="barra" style="width:${Math.max(3, Math.round(v / max * 100))}%"></div></div>`).join('') : ''}
      ${ant.temDados ? `<p class="aviso" style="margin-top:22px">${dif >= 0 ? 'Seu saldo aumentou ' + brl(dif) : 'Seu saldo ficou ' + brl(-dif) + ' menor'} em relação ao mês anterior.</p>` : ''}
      <p class="pequeno" style="margin-top:14px">Gastos por categoria somam despesas pagas e pendentes do mês. Os salários entram pelo valor médio, não pelo valor real recebido.</p>`;
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
      $('res').innerHTML = `<div class="veredito ${cls}">${titulo}</div><p class="contexto" style="margin-bottom:12px">${motivo}</p>
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
    const itens = vis.map(l => `
      <div class="item ${l.pago ? 'paga' : ''}" data-id="${l.id}">
        <div><div class="data">${dataCurta(l.data)}${l.categoria ? ' · ' + esc(l.categoria) : ''}${l.pago ? '' : ' · pendente'}</div><div class="desc">${esc(l.desc)}</div></div>
        <div><div class="val ${l.tipo === 'receita' ? 'rec' : 'desp'}">${l.tipo === 'receita' ? '+ ' : '− '}${brl(l.valor)}</div>
          <div class="acoes"><button class="pagar" data-a="alt">${l.pago ? 'Desfazer' : (l.tipo === 'receita' ? 'Recebi' : 'Paguei')}</button><button data-a="ed">Editar</button><button data-a="del">Excluir</button></div></div>
      </div>`).join('');
    area.innerHTML = `<h1>Contas</h1>
      <button class="botao sec" id="rec" style="margin-top:12px">Contas recorrentes</button>
      <div class="filtros"><button data-f="pendentes" class="${filtro === 'pendentes' ? 'on' : ''}">Pendentes</button><button data-f="todos" class="${filtro === 'todos' ? 'on' : ''}">Todas</button></div>
      ${itens || '<p class="contexto" style="margin-top:24px">Nada por aqui. Toque no + para lançar.</p>'}`;
    area.querySelector('#rec').onclick = () => mostrar('recorrentes');
    area.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filtro = b.dataset.f; mostrar('contas'); });
    area.querySelectorAll('.item').forEach(el => {
      const l = todos.find(x => x.id === +el.dataset.id);
      el.querySelector('[data-a=ed]').onclick = () => abrirLancamento(l);
      el.querySelector('[data-a=alt]').onclick = async () => { l.pago = !l.pago; l.pagoEm = l.pago ? Date.now() : null; await LANC.salvar(l); mostrar('contas'); };
      el.querySelector('[data-a=del]').onclick = async () => { if (confirm('Excluir "' + l.desc + '"?')) { await LANC.apagar(l.id); mostrar('contas'); } };
    });
  }
};

async function abrirLancamento(edit) {
  const sug = [...new Set((await LANC.todos()).map(l => l.desc))];
  const ultima = await DB.ler('ultimaCategoria');
  let tipo = edit ? edit.tipo : 'despesa', pago = edit ? edit.pago : true;
  const f = document.createElement('div'); f.className = 'folha';
  f.innerHTML = `<div class="painel form">
    ${edit ? '<h2>Editar lançamento</h2>' : ''}
    <div class="seg" id="sTipo"><button data-v="despesa">Despesa</button><button data-v="receita">Receita</button></div>
    <label>Valor</label><input id="lv" class="valorgrande" inputmode="numeric" placeholder="R$ 0,00" ${edit ? `data-c="${edit.valor}"` : ''}>
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
fab.onclick = abrirLancamento; document.body.appendChild(fab);

async function mostrar(nome) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativa', b.dataset.tela === (nome === 'recorrentes' ? 'contas' : (nome === 'backup' || nome === 'fechamento') ? 'hoje' : nome)));
  await telas[nome]();
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => mostrar(b.dataset.tela)));
gerarRecorrentes().catch(() => {}).then(() => mostrar('hoje'));

if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); // pede ao iOS para não apagar os dados
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
