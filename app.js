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

/* ---------- Utilidades ---------- */
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

const telas = {
  async hoje() {
    const cfg = await DB.ler('config');
    if (!cfg) return formConfig(null);
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
      <div class="lista"><h1>Próximos recebimentos (valor mínimo)</h1>${lista}</div>
      <button class="botao sec" id="editar" style="margin-top:24px">Editar recebimentos</button>`;
    document.getElementById('editar').onclick = () => formConfig(cfg);
  },
  async comprar() { area.innerHTML = `<div class="vazio"><h1>Posso comprar?</h1><div class="gigante" style="font-size:40px">Em breve</div><p>Aqui você vai digitar um valor, à vista ou parcelado, e ver se cabe antes de comprar.</p></div>`; },
  async contas() { area.innerHTML = `<div class="vazio"><h1>Contas</h1><div class="gigante" style="font-size:40px">Em breve</div><p>Aqui ficará a agenda do que entra e sai, em ordem de data.</p></div>`; }
};

async function mostrar(nome) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativa', b.dataset.tela === nome));
  await telas[nome]();
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => mostrar(b.dataset.tela)));
mostrar('hoje');

if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); // pede ao iOS para não apagar os dados
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
