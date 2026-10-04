// Etapa 1: apenas as telas-esqueleto. Os números abaixo são EXEMPLO.
const telas = {
  hoje() {
    // Curva de exemplo: x = dias do ciclo, y = saldo (valores fictícios)
    const pts = [[0,70],[40,62],[80,48],[120,52],[160,30],[200,36],[240,58],[280,44],[320,40]];
    const d = pts.map((p,i) => (i ? 'L' : 'M') + (p[0]+20) + ' ' + (p[1]+20)).join(' ');
    return `
      <h1>Você pode gastar hoje</h1>
      <div class="gigante"><small>R$</small>48</div>
      <p class="contexto">Exemplo. Dia 14 é o mais apertado: sobram R$ 120.</p>
      <svg class="curva" viewBox="0 0 360 120" role="img" aria-label="Curva de exemplo do saldo até o próximo recebimento">
        <line class="margem" x1="20" x2="340" y1="80" y2="80"/>
        <path class="linha" d="${d}"/>
        <circle class="aperto" cx="180" cy="50" r="5"/>
        <text class="eixo" x="20" y="112">hoje</text>
        <text class="eixo" x="300" y="112">dia 20</text>
      </svg>
      <p class="aviso">Esta tela ainda mostra dados de exemplo. Nas próximas etapas ela passa a usar os seus recebimentos e contas.</p>`;
  },
  comprar() {
    return `<div class="vazio"><h1>Posso comprar?</h1><div class="gigante" style="font-size:40px">Em breve</div>
      <p>Aqui você vai digitar um valor, à vista ou parcelado, e ver se cabe antes de comprar.</p></div>`;
  },
  contas() {
    return `<div class="vazio"><h1>Contas</h1><div class="gigante" style="font-size:40px">Em breve</div>
      <p>Aqui ficará a agenda do que entra e sai, em ordem de data.</p></div>`;
  }
};

const area = document.getElementById('tela');
function mostrar(nome) {
  area.innerHTML = telas[nome]();
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativa', b.dataset.tela === nome));
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => mostrar(b.dataset.tela)));
mostrar('hoje');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
