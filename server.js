// Сервер для воркшопа «Фантомная сеть». Без зависимостей: node server.js [порт]
// Отдаёт war-room.html и статику движка/пакетов, хранит состояние (с rev для
// условных записей), рассылает изменения по SSE, архивирует завершённые игры.
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const ROOT=__dirname;

function makeServer(opts={}){
const HTML=opts.html||path.join(ROOT,'war-room.html');
const FILE=opts.file||path.join(ROOT,'state.json');
const ARCH=opts.archiveDir||path.join(ROOT,'archive');
const EMPTY=()=>({rev:0,game:{status:'LOBBY',panic:0,applied:[],rateSegments:[],events:[]},players:{},wall:{},hypotheses:{},proposals:{},statuses:{}});
let state=EMPTY();try{const raw=JSON.parse(fs.readFileSync(FILE,'utf8'));if(raw&&typeof raw.rev==='number')state=raw;}catch(e){}
const clients=new Set();
function broadcast(){const data='data: '+JSON.stringify(state)+'\n\n';for(const c of clients)c.write(data);try{fs.writeFileSync(FILE,JSON.stringify(state));}catch(e){}}
const nontrivial=()=>!!(state.game.startedAt||Object.keys(state.wall).length||Object.keys(state.hypotheses).length||Object.keys(state.proposals).length||Object.keys(state.statuses).length);
function writeArchive(summary){
  fs.mkdirSync(ARCH,{recursive:true});
  const safe=String(summary.at||new Date().toISOString()).replace(/[^\w.-]+/g,'-');
  const name=safe+'-'+(summary.scenarioId||'game')+'.json';
  fs.writeFileSync(path.join(ARCH,name),JSON.stringify({summary,state}));
  return name;
}
function serveJs(res,file){
  if(!file.startsWith(ROOT)||!fs.existsSync(file)||!file.endsWith('.js')){res.writeHead(404);return res.end();}
  res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});
  fs.createReadStream(file).pipe(res);
}
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  if(u.pathname==='/state'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(state));}
  if(u.pathname==='/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'});res.write('data: '+JSON.stringify(state)+'\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(u.pathname==='/write'&&req.method==='POST'){let b='';req.on('data',d=>{b+=d;if(b.length>1e6)req.destroy();});req.on('end',()=>{try{const op=JSON.parse(b);
      if(op.expectRev!==undefined&&op.expectRev!==state.rev){res.writeHead(409);return res.end();}
      if(op.reset){
        if(op.archive&&nontrivial())writeArchive(op.archive);
        const rev=state.rev+1;state=EMPTY();state.rev=rev;
      }else{
        if(op.col==='game')state.game=op.doc;
        else if(['players','wall','hypotheses','proposals','statuses'].includes(op.col)){if(op.del)delete state[op.col][op.id];else state[op.col][op.id]=op.doc;}
        else throw new Error('bad col');
        state.rev++;
      }
      broadcast();res.writeHead(204);res.end();}catch(e){res.writeHead(400);res.end(String(e.message));}});return;}
  if(u.pathname==='/archive'&&req.method==='GET'){
    let list=[];
    try{list=fs.readdirSync(ARCH).filter(f=>f.endsWith('.json')).map(f=>{try{return Object.assign({file:f},JSON.parse(fs.readFileSync(path.join(ARCH,f),'utf8')).summary);}catch(e){return null;}}).filter(Boolean).sort((a,b)=>b.file.localeCompare(a.file));}catch(e){}
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(list));}
  let m;
  if(u.pathname==='/engine.js')return serveJs(res,path.join(ROOT,'engine.js'));
  if((m=u.pathname.match(/^\/scenarios\/([\w.-]+\.js)$/)))return serveJs(res,path.join(ROOT,'scenarios',m[1]));
  if(u.pathname.startsWith('/scenarios/')){res.writeHead(404);return res.end();}
  if((m=u.pathname.match(/^\/archive\/([\w.-]+\.json)$/))){
    const f=path.resolve(ARCH,m[1]);
    if(!f.startsWith(path.resolve(ARCH)+path.sep)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return fs.createReadStream(f).pipe(res);}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});fs.createReadStream(HTML).pipe(res);
});
return server;
}

if(require.main===module){
const PORT=+(process.argv[2]||8085);
const server=makeServer();
server.listen(PORT,()=>{
  const ips=Object.values(os.networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal).map(i=>i.address);
  console.log('Фантомная сеть запущена.');
  console.log('  Проектор:  http://localhost:'+PORT+'/#projector');
  console.log('  Пульт GM:  http://localhost:'+PORT+'/#gm');
  ips.forEach(ip=>console.log('  Игроки (та же Wi-Fi):  http://'+ip+':'+PORT+'/#play'));
  console.log('Состояние сохраняется в state.json. Архив игр: /archive. Сброс — кнопкой на пульте.');
});
}

module.exports={makeServer};
