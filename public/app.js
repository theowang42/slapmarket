import { start } from './js/store.js';
import { mountArena } from './arena/page.js';

// 只有一个页面：舞台。点开的盘面是舞台上滑出来的侧边栏，不跳页。
mountArena(document.getElementById('app'));
start();
