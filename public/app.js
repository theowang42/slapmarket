import { createRouter } from './js/router.js';
import { mountChrome } from './js/chrome.js';
import { start } from './js/store.js';
import { overview } from './views/overview.js';
import { symbol } from './views/symbol.js';
import { earnings } from './views/earnings.js';
import { breadth } from './views/breadth.js';
import { macro } from './views/macro.js';

// 装配。加新视图就在 routes 里加一行，视图自己订阅 store、自己收摊。
mountChrome();

createRouter({
  host: document.getElementById('view'),
  routes: {
    '/': overview,
    '/earnings': earnings,
    '/breadth': breadth,
    '/macro': macro,
    '/s/:sym': symbol,
  },
});

start();
