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

/* ---------- Telas ---------- */
const area = document.getElementById('tela');

function formConfig(cfg) {
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
      <p class="intro">O <b>mínimo</b> é o que costuma vir no pior caso. O <b>médio</b> é o valor típico. O app planeja com o mínimo.</p>
      <label>Seu nome</label><input id="nomeEu" value="${esc(c.nomes.eu)}" autocomplete="off">
      <label>Nome da sua esposa</label><input id="nomeEsposa" value="${esc(c.nomes.esposa)}" autocomplete="off">
      <label>Margem de segurança (o saldo não deve ficar abaixo disto)</label>
      <input id="margem" inputmode="numeric" data-c="${c.margem}">
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
  await DB.gravar('config', { nomes: { eu, esposa }, margem, recebimentos });
  mostrar('hoje');
}

let filtro = 'pendentes';
const telas = {
  async hoje() {
    const cfg = await DB.ler('config');
    if (!cfg) return formConfig(null);
    const pend = (await LANC.todos()).filter(l => l.tipo === 'despesa' && !l.pago);
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
    area.innerHTML = `
      <h1>Olá, ${esc(cfg.nomes.eu)}</h1>
      <div class="gigante"><small>R$</small>48</div>
      <p class="contexto">Exemplo: este valor ainda não é calculado com os seus dados.</p>
      <svg class="curva" viewBox="0 0 360 120" role="img" aria-label="Curva de exemplo do saldo">
        <line class="margem" x1="20" x2="340" y1="80" y2="80"/>
        <path class="linha" d="M20 90 L60 82 L100 68 L140 72 L180 50 L220 56 L260 78 L300 64 L340 60"/>
        <circle class="aperto" cx="180" cy="70" r="5"/>
      </svg>
      <p class="aviso">Contas pendentes: <b>${pend.length}</b> · ${brl(totalPend)}</p>
      <div class="lista"><h1>Próximos recebimentos (valor mínimo)</h1>${lista}</div>
      <button class="botao sec" id="editar" style="margin-top:24px">Editar recebimentos</button>`;
    document.getElementById('editar').onclick = () => formConfig(cfg);
  },
  async comprar() { area.innerHTML = `<div class="vazio"><h1>Posso comprar?</h1><div class="gigante" style="font-size:40px">Em breve</div><p>Aqui você vai digitar um valor, à vista ou parcelado, e ver se cabe antes de comprar.</p></div>`; },
  async contas() {
    const todos = (await LANC.todos()).sort((a, b) => a.data.localeCompare(b.data) || a.id - b.id);
    const vis = filtro === 'pendentes' ? todos.filter(l => !l.pago) : todos;
    const itens = vis.map(l => `
      <div class="item ${l.pago ? 'paga' : ''}" data-id="${l.id}">
        <div><div class="data">${dataCurta(l.data)}${l.pago ? '' : ' · pendente'}</div><div class="desc">${esc(l.desc)}</div></div>
        <div><div class="val ${l.tipo === 'receita' ? 'rec' : 'desp'}">${l.tipo === 'receita' ? '+ ' : '− '}${brl(l.valor)}</div>
          <div class="acoes"><button class="pagar" data-a="alt">${l.pago ? 'Desfazer' : (l.tipo === 'receita' ? 'Recebi' : 'Paguei')}</button><button data-a="del">Excluir</button></div></div>
      </div>`).join('');
    area.innerHTML = `<h1>Contas</h1>
      <div class="filtros"><button data-f="pendentes" class="${filtro === 'pendentes' ? 'on' : ''}">Pendentes</button><button data-f="todos" class="${filtro === 'todos' ? 'on' : ''}">Todas</button></div>
      ${itens || '<p class="contexto" style="margin-top:24px">Nada por aqui. Toque no + para lançar.</p>'}`;
    area.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filtro = b.dataset.f; mostrar('contas'); });
    area.querySelectorAll('.item').forEach(el => {
      const l = todos.find(x => x.id === +el.dataset.id);
      el.querySelector('[data-a=alt]').onclick = async () => { l.pago = !l.pago; await LANC.salvar(l); mostrar('contas'); };
      el.querySelector('[data-a=del]').onclick = async () => { if (confirm('Excluir "' + l.desc + '"?')) { await LANC.apagar(l.id); mostrar('contas'); } };
    });
  }
};

async function abrirLancamento() {
  const sug = [...new Set((await LANC.todos()).map(l => l.desc))];
  let tipo = 'despesa', pago = true;
  const f = document.createElement('div'); f.className = 'folha';
  f.innerHTML = `<div class="painel form">
    <div class="seg" id="sTipo"><button data-v="despesa">Despesa</button><button data-v="receita">Receita</button></div>
    <label>Valor</label><input id="lv" class="valorgrande" inputmode="numeric" placeholder="R$ 0,00">
    <label>Descrição</label><input id="ld" list="sug" autocomplete="off" placeholder="Ex.: Mercado"><datalist id="sug">${sug.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    <label>Data</label><input id="ldt" type="date" value="${hojeISO()}">
    <label>Situação</label><div class="seg" id="sPago"><button data-v="1"></button><button data-v="0">Pendente</button></div>
    <p class="erro" id="le" role="alert"></p>
    <button class="botao" id="ls">Salvar</button><button class="botao sec" id="lc">Cancelar</button></div>`;
  document.body.appendChild(f);
  const $ = id => f.querySelector('#' + id);
  const pintar = () => {
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
    await LANC.salvar({ tipo, desc, valor, data, pago });
    fechar(); mostrar(document.querySelector('nav .ativa').dataset.tela);
  };
}
const fab = document.createElement('button'); fab.className = 'fab'; fab.textContent = '+'; fab.setAttribute('aria-label', 'Novo lançamento');
fab.onclick = abrirLancamento; document.body.appendChild(fab);

async function mostrar(nome) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativa', b.dataset.tela === nome));
  await telas[nome]();
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => mostrar(b.dataset.tela)));
mostrar('hoje');

if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); // pede ao iOS para não apagar os dados
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
