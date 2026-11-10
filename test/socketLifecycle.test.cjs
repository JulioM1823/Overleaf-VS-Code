const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request,parent,main){
 if(request==='../comments/commentDiagnostics'){return {logCommentDiagnostics:()=>{}};}
 if(request==='vscode'){return {Disposable:class{constructor(fn){this.fn=fn;}dispose(){this.fn?.();}}};}
 if(parent?.filename?.endsWith('/api/socketio.js') && request==='./socketioAlt'){return {SocketIOAlt:class{}};}
 return originalLoad.call(this,request,parent,main);
};
const {SocketIOAPI}=require('../out/api/socketio');
const {EventBus}=require('../out/utils/eventBus');
function fixture(project='project'){
 const sockets=[];
 const api={_initSocketV0(){const socket=new EventEmitter();socket.socket={options:{'auto connect':false},connected:true,connect(){}};
  socket.disconnect=()=>{socket.socket.connected=false;socket.emit('disconnect','booted');};sockets.push(socket);return socket;}};
 const connection=new SocketIOAPI('https://example.test',api,{cookies:'synthetic',csrfToken:'synthetic'},project);
 return {connection,sockets};
}
test('retiring a socket cannot emit disconnect into its replacement session',()=>{
 const {connection,sockets}=fixture();let disconnected=0;
 connection.updateEventHandlers({onDisconnected:()=>disconnected++});
 connection.init(true);
 assert.equal(disconnected,0,'Intentional replacement must not schedule project recovery');
 sockets[0].emit('disconnect');assert.equal(disconnected,0);
 sockets[1].emit('disconnect');assert.equal(disconnected,1);
 connection.disconnect();
});
test('acceptance stays local to its own connection and fires once',()=>{
 const a=fixture('a'),b=fixture('b');const acceptedA=[],acceptedB=[];
 a.connection.updateEventHandlers({onConnectionAccepted:id=>acceptedA.push(id)});
 b.connection.updateEventHandlers({onConnectionAccepted:id=>acceptedB.push(id)});
 a.sockets[0].emit('joinProjectResponse',{publicId:'a-client',project:{_id:'a'}});
 assert.deepEqual(acceptedA,['a-client']);assert.deepEqual(acceptedB,[],'Other projects/connections must not observe acceptance');
 b.sockets[0].emit('joinProjectResponse',{publicId:'b-client',project:{_id:'b'}});
 assert.deepEqual(acceptedA,['a-client']);assert.deepEqual(acceptedB,['b-client']);
 a.connection.disconnect();b.connection.disconnect();
});
test('late HTTP handshake completion cannot open a retired transport',()=>{
 const sockets=[],opened=[];const pending=[];
 const api={_initSocketV0(){const socket=new EventEmitter(),index=sockets.length;
  socket.socket={options:{'auto connect':false},connected:false,
   handshake:callback=>pending.push(callback),connect(){this.handshake(()=>{opened.push(index);});}};
  socket.disconnect=()=>{};sockets.push(socket);return socket;}};
 const connection=new SocketIOAPI('https://example.test',api,{},'p');
 connection.init(true);connection.init(true);
 pending[0]('retired',60,60,'websocket');pending[1]('active',60,60,'websocket');
 assert.deepEqual(opened,[2]);connection.disconnect();
});
test('100 replacement cycles keep listeners and acceptance notifications bounded',()=>{
 const {connection,sockets}=fixture();let accepted=0,disconnected=0;
 connection.updateEventHandlers({onConnectionAccepted:()=>accepted++,onDisconnected:()=>disconnected++});
 for(let i=0;i<100;i++){
  connection.init(true);const active=sockets.at(-1);
  active.emit('joinProjectResponse',{publicId:`client-${i}`,project:{_id:'p'}});
  active.emit('connectionAccepted',undefined,`client-${i}`);
  assert.equal(active.listenerCount('disconnect'),2);assert.equal(sockets.at(-2).eventNames().length,0);
 }
 assert.equal(accepted,100);assert.equal(disconnected,0);connection.disconnect();
});
test('closing during cookie refresh cancels later handshake and connection creation',async()=>{
 const {connection,sockets}=fixture();let release;
 connection.api.updateCookies=()=>new Promise(resolve=>release=resolve);
 connection.api.probeRealtimeHandshake=()=>assert.fail('Cancelled refresh must not probe or reopen');
 const pending=connection.prepareForJoin();connection.disconnect();release();
 await assert.rejects(pending,/initialization cancelled/);assert.equal(sockets.length,1);
});
