/* Маршрутизация по хэшу: #screen — проектор, #play — телефон роли, #gm — пульт, #cards — карточки, #stats — аналитика.
   Без хэша: с телефона — роль, с большого экрана — пульт (там же ссылки на проектор и карточки). */
(function () {
  'use strict';
  const routes = { screen: () => SCREEN.start(), play: () => PLAY.start(), gm: () => GM.start(), cards: () => GM.cards(), stats: () => GM.stats() };
  let name = location.hash.slice(1);
  if (!routes[name]) name = matchMedia('(max-width: 640px)').matches ? 'play' : 'gm';
  document.getElementById(name).classList.add('on');
  document.documentElement.classList.add('v-' + name);
  routes[name]();
  // Смена хэша в той же вкладке — перезагрузка: у каждого экрана свой поток и своё состояние.
  window.addEventListener('hashchange', () => location.reload());
})();
