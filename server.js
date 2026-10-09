// Сервер воркшопа инцидентов. Без зависимостей: node server.js [порт]
// Отдаёт war-room.html, hall.html и статику движков/пакетов, хранит состояние
// war-room (с rev для условных записей), рассылает изменения по SSE,
// архивирует завершённые игры. Окружение: PORT, HOST, DATA_DIR, GM_PIN.
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const ROOT=__dirname;
const COLS=['players','wall','hypotheses','proposals','statuses'];
const ID_RE=/^[\w-]{1,64}$/;
const HEARTBEAT_MS=25000; // прокси и мобильные сети рвут молчащий SSE через 30–60 с
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

function makeServer(opts={}){
const HTML=opts.html||path.join(ROOT,'war-room.html');
const DATA=process.env.DATA_DIR||ROOT; // каталог состояния и архива (в Docker — том)
const FILE=opts.file||path.join(DATA,'state.json');
const ARCH=opts.archiveDir||path.join(DATA,'archive');
// PIN ведущего: если задан, писать game и делать reset можно только с заголовком x-gm-pin.
// Игроки (players, wall, hypotheses, proposals, statuses) пишут без PIN.
const GM_PIN=opts.gmPin!==undefined?opts.gmPin:(process.env.GM_PIN||'');
const log=opts.log?(...a)=>console.log(new Date().toTimeString().slice(0,8),...a.filter(x=>x!==''&&x!=null)):()=>{};
const STATIC={'/hall.html':path.join(ROOT,'hall.html'),'/engine.js':path.join(ROOT,'engine.js'),'/hall-engine.js':path.join(ROOT,'hall-engine.js'),'/theme.css':path.join(ROOT,'theme.css'),'/fonts/fonts.css':path.join(ROOT,'fonts','fonts.css')};
const EMPTY=()=>({rev:0,game:{status:'LOBBY',panic:0,applied:[],rateSegments:[],events:[]},players:{},wall:{},hypotheses:{},proposals:{},statuses:{}});
let state=EMPTY();try{const raw=JSON.parse(fs.readFileSync(FILE,'utf8'));if(raw&&typeof raw.rev==='number')state=raw;}catch(e){}
const clients=new Set();
// Атомарная запись: обрыв питания посреди writeFileSync не оставит битый state.json.
function persist(){const tmp=FILE+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,FILE);}catch(e){console.error('Не удалось сохранить состояние:',e.message);}}
function broadcast(){const data='data: '+JSON.stringify(state)+'\n\n';for(const c of clients)c.write(data);persist();}
const nontrivial=()=>!!(state.game.startedAt||Object.keys(state.wall).length||Object.keys(state.hypotheses).length||Object.keys(state.proposals).length||Object.keys(state.statuses).length);
function writeArchive(summary){
  fs.mkdirSync(ARCH,{recursive:true});
  const safe=String(summary.at||new Date().toISOString()).replace(/[^\w.-]+/g,'-');
  const name=safe+'-'+String(summary.scenarioId||'game').replace(/[^\w.-]+/g,'-')+'.json';
  fs.writeFileSync(path.join(ARCH,name),JSON.stringify({summary,state}));
  return name;
}
function serveFile(res,file,type){
  if(!file.startsWith(ROOT)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'content-type':type,'cache-control':'no-store'});
  fs.createReadStream(file).pipe(res);
}
const serveJs=(res,file)=>file.endsWith('.js')?serveFile(res,file,'text/javascript; charset=utf-8'):(res.writeHead(404),res.end());
// Применяет операцию записи; бросает при невалидной (→ 400, состояние не тронуто).
function applyOp(op){
  if(!isObj(op))throw new Error('bad op');
  if(op.reset){
    if(op.archive&&nontrivial())writeArchive(op.archive);
    const rev=state.rev+1;state=EMPTY();state.rev=rev;return;
  }
  if(op.col==='game'){if(!isObj(op.doc))throw new Error('bad doc');state.game=op.doc;}
  else if(COLS.includes(op.col)){
    if(!ID_RE.test(String(op.id)))throw new Error('bad id');
    if(op.del)delete state[op.col][op.id];
    else{if(!isObj(op.doc))throw new Error('bad doc');state[op.col][op.id]=op.doc;}
  }
  else throw new Error('bad col');
  state.rev++;
}
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  if(u.pathname==='/healthz'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({ok:true,rev:state.rev,status:state.game.status,clients:clients.size,gmPin:!!GM_PIN}));}
  if(u.pathname==='/state'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(state));}
  if(u.pathname==='/events'){
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
    res.write('data: '+JSON.stringify(state)+'\n\n');clients.add(res);
    const hb=setInterval(()=>res.write(': ping\n\n'),HEARTBEAT_MS);hb.unref();
    req.on('close',()=>{clearInterval(hb);clients.delete(res);});return;}
  if(u.pathname==='/write'&&req.method==='POST'){let b='';req.on('data',d=>{b+=d;if(b.length>1e6)req.destroy();});req.on('end',()=>{try{const op=JSON.parse(b);
      if(GM_PIN&&op&&(op.reset||op.col==='game')&&req.headers['x-gm-pin']!==GM_PIN){log('401',op.reset?'reset':'game','неверный PIN');res.writeHead(401);return res.end('gm pin required');}
      if(op&&op.expectRev!==undefined&&op.expectRev!==state.rev){log('409',op.col||'reset','expectRev',op.expectRev,'rev',state.rev);res.writeHead(409);return res.end();}
      const before=state.game.status;
      applyOp(op);
      // Журнал для разбора спорных моментов: каждая запись — одна строка в stdout.
      if(op.reset)log('rev',state.rev,'RESET',op.archive?'архив: '+(op.archive.scenarioId||'')+' '+(op.archive.status||''):'');
      else log('rev',state.rev,op.col+(op.id?'/'+op.id:''),op.del?'удалено':'',op.col==='game'&&before!==state.game.status?before+' → '+state.game.status:'');
      broadcast();res.writeHead(204,{'x-rev':String(state.rev)});res.end();}catch(e){log('400',e.message);res.writeHead(400);res.end(String(e.message));}});return;}
  if(u.pathname==='/archive'&&req.method==='GET'){
    let list=[];
    try{list=fs.readdirSync(ARCH).filter(f=>f.endsWith('.json')).map(f=>{try{return Object.assign({file:f},JSON.parse(fs.readFileSync(path.join(ARCH,f),'utf8')).summary);}catch(e){return null;}}).filter(Boolean).sort((a,b)=>b.file.localeCompare(a.file));}catch(e){}
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(list));}
  let m;
  if(STATIC[u.pathname]){const f=STATIC[u.pathname];return f.endsWith('.js')?serveJs(res,f):serveFile(res,f,f.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');}
  if((m=u.pathname.match(/^\/scenarios\/([\w.-]+\.js)$/)))return serveJs(res,path.join(ROOT,'scenarios',m[1]));
  if((m=u.pathname.match(/^\/fonts\/([\w.-]+\.woff2)$/)))return serveFile(res,path.join(ROOT,'fonts',m[1]),'font/woff2');
  if((m=u.pathname.match(/^\/archive\/([\w.-]+\.json)$/))){
    const f=path.resolve(ARCH,m[1]);
    if(!f.startsWith(path.resolve(ARCH)+path.sep)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return fs.createReadStream(f).pipe(res);}
  if(u.pathname==='/'||u.pathname==='/index.html'||u.pathname==='/war-room.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return fs.createReadStream(HTML).pipe(res);}
  res.writeHead(404);res.end();
});
// Закрывает SSE-соединения, иначе server.close() ждёт их вечно.
const close=server.close.bind(server);
server.close=cb=>{for(const c of clients)c.end();clients.clear();return close(cb);};
return server;
}

if(require.main===module){
const PORT=+(process.argv[2]||process.env.PORT||8085);
const HOST=process.env.HOST||'0.0.0.0';
const server=makeServer({log:true});
server.listen(PORT,HOST,()=>{
  const ips=Object.values(os.networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal).map(i=>i.address);
  console.log('Воркшоп инцидентов запущен.');
  console.log('  Холл-режим: http://localhost:'+PORT+'/hall.html');
  console.log('  War-room, проектор:  http://localhost:'+PORT+'/#projector');
  console.log('  War-room, пульт GM:  http://localhost:'+PORT+'/#gm');
  ips.forEach(ip=>console.log('  Игроки (та же Wi-Fi):  http://'+ip+':'+PORT+'/#play'));
  console.log('Состояние: state.json. Архив игр: archive/. Сброс — кнопкой на пульте.');
  console.log(process.env.GM_PIN?'Пульт защищён PIN (GM_PIN).':'Пульт открыт всем в сети. Чтобы защитить: GM_PIN=1234 npm start');
});
const stop=()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
}

module.exports={makeServer};
