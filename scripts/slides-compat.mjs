// Preserve the old 3030 entry point without running a second Slidev compiler.
import 'dotenv/config';
import http from 'node:http';
const webPort=Number(process.env.WEB_PORT || 5173);
const server=http.createServer((req,res)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:webPort,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${webPort}`}},response=>{res.writeHead(response.statusCode || 502,response.headers);response.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end('Frontend is starting');});
  req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
});
server.on('upgrade',(req,socket,head)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:webPort,path:req.url,headers:{...req.headers,host:`127.0.0.1:${webPort}`}});
  upstream.on('upgrade',(res,remote,upstreamHead)=>{
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if(upstreamHead.length)socket.write(upstreamHead);if(head.length)remote.write(head);
    socket.pipe(remote).pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());
  });
  upstream.on('error',()=>socket.destroy());upstream.end();
});
server.listen(Number(process.env.SLIDEV_PORT || 3030),'127.0.0.1',()=>console.log('Slidev compatibility entry ready'));
process.on('SIGTERM',()=>server.close(()=>process.exit()));
