// Сервер воркшопа инцидентов. Без зависимостей: node server.js [порт]
// Отдаёт war-room.html, hall.html и статику движков/пакетов, хранит состояние
// war-room (с rev для условных записей), рассылает изменения по SSE,
// архивирует завершённые игры. Порт/хост: аргумент или PORT/HOST в окружении.
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const ROOT=__dirname;
const COLS=['players','wall','hypotheses','proposals','statuses'];
const ID_RE=/^[\w-]{1,64}$/;
const HEARTBEAT_MS=25000; // прокси и мобильные сети рвут молчащий SSE через 30–60 с
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

function makeServer(opts={}){
const HTML=opts.html||path.join(ROOT,'war-room.html');
const FILE=opts.file||path.join(ROOT,'state.json');
const ARCH=opts.archiveDir||path.join(ROOT,'archive');
const STATIC={'/hall.html':path.join(ROOT,'hall.html'),'/engine.js':path.join(ROOT,'engine.js'),'/hall-engine.js':path.join(ROOT,'hall-engine.js')};
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
  if(u.pathname==='/healthz'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({ok:true,rev:state.rev,status:state.game.status,clients:clients.size}));}
  if(u.pathname==='/state'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(state));}
  if(u.pathname==='/events'){
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
    res.write('data: '+JSON.stringify(state)+'\n\n');clients.add(res);
    const hb=setInterval(()=>res.write(': ping\n\n'),HEARTBEAT_MS);hb.unref();
    req.on('close',()=>{clearInterval(hb);clients.delete(res);});return;}
  if(u.pathname==='/write'&&req.method==='POST'){let b='';req.on('data',d=>{b+=d;if(b.length>1e6)req.destroy();});req.on('end',()=>{try{const op=JSON.parse(b);
      if(op&&op.expectRev!==undefined&&op.expectRev!==state.rev){res.writeHead(409);return res.end();}
      applyOp(op);
      broadcast();res.writeHead(204,{'x-rev':String(state.rev)});res.end();}catch(e){res.writeHead(400);res.end(String(e.message));}});return;}
  if(u.pathname==='/archive'&&req.method==='GET'){
    let list=[];
    try{list=fs.readdirSync(ARCH).filter(f=>f.endsWith('.json')).map(f=>{try{return Object.assign({file:f},JSON.parse(fs.readFileSync(path.join(ARCH,f),'utf8')).summary);}catch(e){return null;}}).filter(Boolean).sort((a,b)=>b.file.localeCompare(a.file));}catch(e){}
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(list));}
  let m;
  if(STATIC[u.pathname])return u.pathname.endsWith('.js')?serveJs(res,STATIC[u.pathname]):serveFile(res,STATIC[u.pathname],'text/html; charset=utf-8');
  if((m=u.pathname.match(/^\/scenarios\/([\w.-]+\.js)$/)))return serveJs(res,path.join(ROOT,'scenarios',m[1]));
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
const server=makeServer();
server.listen(PORT,HOST,()=>{
  const ips=Object.values(os.networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal).map(i=>i.address);
  console.log('Воркшоп инцидентов запущен.');
  console.log('  Холл-режим: http://localhost:'+PORT+'/hall.html');
  console.log('  War-room, проектор:  http://localhost:'+PORT+'/#projector');
  console.log('  War-room, пульт GM:  http://localhost:'+PORT+'/#gm');
  ips.forEach(ip=>console.log('  Игроки (та же Wi-Fi):  http://'+ip+':'+PORT+'/#play'));
  console.log('Состояние: state.json. Архив игр: archive/. Сброс — кнопкой на пульте.');
});
const stop=()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
}

module.exports={makeServer};
