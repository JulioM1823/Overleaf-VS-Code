const test=require('node:test');
const assert=require('node:assert/strict');
const {BaseAPI}=require('../out/api/base');
for(const method of ['uploadFile','uploadProject']){
 test(`${method} streams Uint8Array content as bytes rather than individual numbers`,async()=>{
  const api=new BaseAPI('https://example.test');
  const content=new Uint8Array([0,255,128,65,13,10]);let chunks;
  api.request=async(_method,_route,form)=>{
   chunks=[];await new Promise((resolve,reject)=>{form.on('data',chunk=>chunks.push(chunk));form.on('end',resolve);form.on('error',reject);form.resume();});
   return {type:'success'};
  };
  const identity={cookies:'synthetic',csrfToken:'synthetic'};
  if(method==='uploadFile'){await api.uploadFile(identity,'project','folder','audit.bin',content);}
  else{await api.uploadProject(identity,'audit.zip',content);}
  assert(chunks.every(chunk=>typeof chunk==='string'||chunk instanceof Uint8Array),'HTTP bodies cannot contain numeric chunks');
  const body=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)));
  assert(body.includes(Buffer.from(content)),'Multipart body must preserve all binary bytes');
 });
}
