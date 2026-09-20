import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { config, readRobotConfig } from './config.js';
import { audit, countEnabledAdmins, createRobotConnection, createSession, createUser, deleteRobotConnection, deleteSession, ensureAdmin, findRobotConnectionById, findUserByEmail, findUserBySession, listAudit, listRobotConnections, listUsers, updateUser, type Role, type User } from './db.js';
import { hashPassword, verifyPassword } from './password.js';
import { robot, type RobotTarget } from './robot.js';

declare module 'fastify' { interface FastifyRequest { user?: User } }
const app = Fastify({ logger: true });
await app.register(cookie);
await app.register(websocket);
await app.register(fastifyStatic, { root: path.resolve(config.webRoot), prefix: '/', serve: false });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const userCreateSchema = z.object({ email: z.string().email(), displayName: z.string().min(1).max(120), password: z.string().min(12), role: z.enum(['admin','operator','viewer']) });
const userPatchSchema = z.object({ displayName: z.string().min(1).max(120).optional(), password: z.string().min(12).optional(), role: z.enum(['admin','operator','viewer']).optional(), enabled: z.boolean().optional() });
const commandSchema = z.object({ command: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) });
const robotConnectionSchema = z.object({ name: z.string().trim().min(1).max(80), host: z.string().trim().min(1).max(255), port: z.coerce.number().int().min(1).max(65535), token: z.string().min(1).max(4096) });
const robotConnectSchema = z.object({ profileId: z.coerce.number().int().positive() });
const allowedRobotCommands = new Set(['system.ping','system.describe','state.get','state.subscribe','control.acquire','control.enable','control.heartbeat','control.release','motion.stop','motion.stop_all','motion.keepalive','base.jog','body.lift.jog','body.pitch.jog','waist.yaw.jog','arm.position.jog','arm.rotation.jog','arm.move_to','gripper.jog','head.jog','head.center']);
const sessionCookie = { httpOnly: true, sameSite: 'lax' as const, secure: config.isProduction, path: '/' };
function unauthorized(reply: FastifyReply) { return reply.code(401).send({ ok:false, code:'UNAUTHORIZED', msg:'Login required', data:{} }); }
async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> { const user = findUserBySession(request.cookies[config.cookieName]); if (!user || !user.enabled) { unauthorized(reply); return; } request.user = user; }
function roleGuard(...roles: Role[]) { return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => { await requireAuth(request, reply); if (!request.user) return; if (!roles.includes(request.user.role)) reply.code(403).send({ ok:false, code:'FORBIDDEN', msg:'Insufficient role', data:{} }); }; }
function publicUser(user: User | (User & { passwordHash?: string })) { const safe = { ...user } as Record<string, unknown>; delete safe.passwordHash; return safe; }
function publicRobotConnection(profile: ReturnType<typeof findRobotConnectionById>) { if (!profile) return null; const { token: _token, ...safe } = profile; return { ...safe, hasToken: Boolean(profile.token) }; }
function sendJson(socket: any, value: unknown): void { if (socket.readyState === 1) socket.send(JSON.stringify(value)); }

app.get('/healthz', async () => ({ ok:true, service:'robot-station-server', robot:robot.getStatus() }));
app.post('/api/auth/login', async (request, reply) => { const parsed=loginSchema.safeParse(request.body); if(!parsed.success) return reply.code(400).send({ok:false,code:'INVALID_ARGUMENT',msg:'Invalid login input',data:{}}); const user=findUserByEmail(parsed.data.email); if(!user || !user.enabled || !(await verifyPassword(parsed.data.password,user.passwordHash))) return reply.code(401).send({ok:false,code:'UNAUTHORIZED',msg:'Invalid email or password',data:{}}); const token=createSession(user.id,Date.now()+config.sessionDays*86400000); reply.setCookie(config.cookieName,token,{...sessionCookie,maxAge:config.sessionDays*86400}); audit(user.id,'auth.login',{email:user.email}); return {ok:true,code:'OK',msg:'Logged in',data:{user:publicUser(user)}}; });
app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => { deleteSession(request.cookies[config.cookieName]); reply.clearCookie(config.cookieName,{path:'/'}); if(request.user) audit(request.user.id,'auth.logout',{}); return {ok:true,code:'OK',msg:'Logged out',data:{}}; });
app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({ok:true,code:'OK',msg:'Authenticated',data:{user:publicUser(request.user!)}}));
app.get('/api/users', { preHandler: roleGuard('admin') }, async () => ({ok:true,code:'OK',msg:'Users',data:{users:listUsers().map(publicUser)}}));
app.get('/api/audit', { preHandler: roleGuard('admin') }, async () => ({ok:true,code:'OK',msg:'Audit log',data:{entries:listAudit()}}));
app.post('/api/users', { preHandler: roleGuard('admin') }, async (request, reply) => { const parsed=userCreateSchema.safeParse(request.body); if(!parsed.success) return reply.code(400).send({ok:false,code:'INVALID_ARGUMENT',msg:'Invalid user input',data:{}}); try { const user=createUser({email:parsed.data.email,displayName:parsed.data.displayName,passwordHash:await hashPassword(parsed.data.password),role:parsed.data.role}); audit(request.user!.id,'user.create',{userId:user.id,email:user.email,role:user.role}); return reply.code(201).send({ok:true,code:'OK',msg:'User created',data:{user:publicUser(user)}}); } catch { return reply.code(409).send({ok:false,code:'DUPLICATE_ID',msg:'Email already exists',data:{}}); } });
app.patch('/api/users/:id', { preHandler: roleGuard('admin') }, async (request, reply) => { const parsed=userPatchSchema.safeParse(request.body); const id=Number((request.params as {id:string}).id); if(!Number.isInteger(id)||!parsed.success) return reply.code(400).send({ok:false,code:'INVALID_ARGUMENT',msg:'Invalid user input',data:{}}); const patch=parsed.data; const current=listUsers().find(item=>item.id===id); if (!current) return reply.code(404).send({ok:false,code:'NOT_FOUND',msg:'User not found',data:{}}); if (patch.enabled===false && id===request.user!.id) return reply.code(409).send({ok:false,code:'INVALID_ARGUMENT',msg:'You cannot disable your own account',data:{}}); const removingAdmin=current.role==='admin' && ((patch.role !== undefined && patch.role !== 'admin') || patch.enabled === false); if (removingAdmin && countEnabledAdmins() <= 1) return reply.code(409).send({ok:false,code:'INVALID_ARGUMENT',msg:'At least one enabled administrator is required',data:{}}); const changes: {displayName?:string;role?:Role;enabled?:boolean;passwordHash?:string} = {}; if (patch.displayName !== undefined) changes.displayName=patch.displayName; if (patch.role !== undefined) changes.role=patch.role; if (patch.enabled !== undefined) changes.enabled=patch.enabled; if (patch.password !== undefined) changes.passwordHash=await hashPassword(patch.password); const user=updateUser(id,changes); audit(request.user!.id,'user.update',{userId:id,changes:Object.keys(patch)}); return {ok:true,code:'OK',msg:'User updated',data:{user:publicUser(user!)}}; });
app.get('/api/robot/connections', { preHandler: requireAuth }, async () => ({ok:true,code:'OK',msg:'Robot connections',data:{connections:listRobotConnections().map(publicRobotConnection)}}));
app.post('/api/robot/connections', { preHandler: roleGuard('admin','operator') }, async (request, reply) => { const parsed=robotConnectionSchema.safeParse(request.body); if(!parsed.success) return reply.code(400).send({ok:false,code:'INVALID_ARGUMENT',msg:'Invalid robot connection input',data:{}}); try { const profile=createRobotConnection(parsed.data); audit(request.user!.id,'robot.connection.create',{connectionId:profile.id,name:profile.name,host:profile.host,port:profile.port}); return reply.code(201).send({ok:true,code:'OK',msg:'Robot connection saved',data:{connection:publicRobotConnection(profile)}}); } catch { return reply.code(409).send({ok:false,code:'DUPLICATE_ID',msg:'Connection name already exists',data:{}}); } });
app.delete('/api/robot/connections/:id', { preHandler: roleGuard('admin','operator') }, async (request, reply) => { const id=Number((request.params as {id:string}).id); if(!Number.isInteger(id)) return reply.code(400).send({ok:false,code:'INVALID_ARGUMENT',msg:'Invalid connection id',data:{}}); if (robot.getStatus().connectionId===id) return reply.code(409).send({ok:false,code:'CONNECTION_ACTIVE',msg:'Disconnect the active robot before deleting this connection',data:{}}); if(!deleteRobotConnection(id)) return reply.code(404).send({ok:false,code:'NOT_FOUND',msg:'Robot connection not found',data:{}}); audit(request.user!.id,'robot.connection.delete',{connectionId:id}); return {ok:true,code:'OK',msg:'Robot connection deleted',data:{}}; });
app.get('/api/robot/status', { preHandler: requireAuth }, async () => ({ok:true,code:'OK',msg:'Robot status',data:robot.getStatus()}));
app.post('/api/robot/connect', { preHandler: roleGuard('admin','operator') }, async (request, reply) => { const parsed=robotConnectSchema.safeParse(request.body); if(!parsed.success) return reply.code(400).send({ok:false,code:'INVALID_ARGUMENT',msg:'A saved connection is required',data:{}}); const profile=findRobotConnectionById(parsed.data.profileId); if(!profile) return reply.code(404).send({ok:false,code:'NOT_FOUND',msg:'Robot connection not found',data:{}}); if (leaseOwner) return reply.code(409).send({ok:false,code:'CONTROL_BUSY',msg:'Stop and release the active control lease before switching robots',data:{}}); const target: RobotTarget={host:profile.host,port:profile.port,token:profile.token,profileId:profile.id,profileName:profile.name}; try { await robot.reconnect(target); audit(request.user!.id,'robot.connection.select',{connectionId:profile.id,name:profile.name}); return {ok:true,code:'OK',msg:'Robot connection established',data:robot.getStatus()}; } catch(error) { return reply.code(502).send({ok:false,code:'ROBOT_UNAVAILABLE',msg:error instanceof Error?error.message:'Robot unavailable',data:robot.getStatus()}); } });
app.post('/api/robot/reconnect', { preHandler: roleGuard('admin','operator') }, async (_request, reply) => { try { await robot.reconnect(); return {ok:true,code:'OK',msg:'Robot connection refreshed',data:robot.getStatus()}; } catch(error) { return reply.code(502).send({ok:false,code:'ROBOT_UNAVAILABLE',msg:error instanceof Error?error.message:'Robot unavailable',data:robot.getStatus()}); } });
app.post('/api/robot/command', { preHandler: roleGuard('admin','operator') }, async (request, reply) => { const parsed=commandSchema.safeParse(request.body); if(!parsed.success) return reply.code(400).send({ok:false,code:'INVALID_ARGUMENT',msg:'Invalid command input',data:{}}); if(!allowedRobotCommands.has(parsed.data.command)) return reply.code(400).send({ok:false,code:'INVALID_ARGUMENT',msg:'Command is not allowed by the gateway',data:{}}); try { const response=await robot.send(parsed.data.command,parsed.data.params); audit(request.user!.id,'robot.command',{command:parsed.data.command,ok:response.ok,code:response.code}); const data={...response.data}; if(parsed.data.command==='control.acquire') delete data.lease_id; return {ok:response.ok,code:response.code,msg:response.msg,data}; } catch(error) { return reply.code(502).send({ok:false,code:'ROBOT_TIMEOUT',msg:error instanceof Error?error.message:'Robot unavailable',data:{}}); } });

type ControlState = { leaseId: string | null; enabled: boolean; closed: boolean; chain: Promise<void> };
const controlSockets = new Set<any>();
let leaseOwner: ControlState | null = null;
function ack(socket: any, id: unknown, motionId: unknown, response: {ok:boolean; code:string; msg:string; data?:Record<string,unknown>}, command?: string) { sendJson(socket, { web_v:1, type:'ack', id: typeof id==='string' ? id : undefined, motion_id: typeof motionId==='string' ? motionId : null, command, ok:response.ok, code:response.code, msg:response.msg, data:response.data ?? {} }); }
function asFailure(error: unknown) { return { ok:false, code:'ROBOT_TIMEOUT', msg:error instanceof Error ? error.message : 'Robot unavailable', data:{} }; }
async function releaseControl(state: ControlState) {
  const leaseId = state.leaseId;
  if (!leaseId) { state.enabled = false; if (leaseOwner === state) leaseOwner = null; return; }
  // Keep the owner reserved until the robot has received the stop and release
  // frames. A page refresh can open a new socket immediately; releasing the
  // gateway lease first would let that socket race the old cleanup on ZRCP.
  state.enabled = false;
  try { await robot.send('motion.stop_all',{lease_id:leaseId}); } catch {}
  try { await robot.send('control.release',{lease_id:leaseId}); } catch {}
  state.leaseId = null;
  if (leaseOwner === state) leaseOwner = null;
}
async function handleControlMessage(socket: any, state: ControlState, user: User, raw: string) {
  let message: {type?:string; id?:string; action?:string; motion_id?:string; params?:Record<string,unknown>};
  try { message=JSON.parse(raw); } catch { ack(socket,undefined,null,{ok:false,code:'INVALID_MESSAGE',msg:'Invalid WebSocket message',data:{}}); return; }
  if (message.type==='ping') { sendJson(socket,{web_v:1,type:'pong',id:message.id,bridge_time_ms:Date.now()}); return; }
  if (message.type!=='intent' || typeof message.action!=='string' || !allowedRobotCommands.has(message.action)) { ack(socket,message.id,message.motion_id,{ok:false,code:'INVALID_ARGUMENT',msg:'Command is not allowed by the gateway',data:{}}); return; }
  if (!['admin','operator'].includes(user.role)) { ack(socket,message.id,message.motion_id,{ok:false,code:'FORBIDDEN',msg:'Operator role required',data:{}} ,message.action); return; }
  const params = { ...(message.params ?? {}) };
  try {
    if (message.action==='control.acquire') { if (leaseOwner && leaseOwner !== state) { ack(socket,message.id,null,{ok:false,code:'CONTROL_BUSY',msg:'Another operator currently holds control',data:{}},message.action); return; } if (state.leaseId) { ack(socket,message.id,null,{ok:true,code:'OK',msg:'Control lease already held',data:{enabled:state.enabled}},message.action); return; } leaseOwner=state; const response=await robot.send('control.acquire',params); const leaseId=typeof response.data.lease_id==='string' ? response.data.lease_id : null; if (response.ok && leaseId) state.leaseId=leaseId; else if (leaseOwner === state) leaseOwner=null; const data={...response.data}; delete data.lease_id; ack(socket,message.id,null,{...response,data},message.action); return; }
    if (message.action==='control.enable') { if (!state.leaseId && leaseOwner && leaseOwner !== state) { ack(socket,message.id,null,{ok:false,code:'CONTROL_BUSY',msg:'Another operator currently holds control',data:{}},message.action); return; } if (!state.leaseId) { leaseOwner=state; const acquired=await robot.send('control.acquire',{}); const leaseId=typeof acquired.data.lease_id==='string' ? acquired.data.lease_id : null; if(!acquired.ok || !leaseId) { if (leaseOwner === state) leaseOwner=null; ack(socket,message.id,null,acquired,message.action); return; } state.leaseId=leaseId; } const response=await robot.send('control.enable',{...params,lease_id:state.leaseId}); if (response.ok) state.enabled=true; else { await releaseControl(state); } ack(socket,message.id,null,{...response,data:{...response.data,enabled:response.ok}},message.action); return; }
    if (message.action==='control.release') { const leaseId=state.leaseId; const response=leaseId ? await robot.send('control.release',{...params,lease_id:leaseId}) : {ok:true,code:'OK',msg:'Control already released',data:{}}; state.leaseId=null; state.enabled=false; if (leaseOwner===state) leaseOwner=null; ack(socket,message.id,null,response,message.action); return; }
    if (message.action==='motion.stop_all') { const response=await robot.send('motion.stop_all',{...params,...(state.leaseId?{lease_id:state.leaseId}:{})}); state.enabled=false; ack(socket,message.id,null,response,message.action); return; }
    if (['control.heartbeat','motion.stop','motion.keepalive','base.jog','body.lift.jog','body.pitch.jog','waist.yaw.jog','arm.position.jog','arm.rotation.jog','arm.move_to','gripper.jog','head.jog','head.center'].includes(message.action) && !state.leaseId) { ack(socket,message.id,message.motion_id,{ok:false,code:'LEASE_REQUIRED',msg:'Control lease is not enabled',data:{}},message.action); return; }
    if (state.leaseId) params.lease_id=state.leaseId;
    const response=await robot.send(message.action,params); ack(socket,message.id,message.motion_id,response,message.action);
  } catch (error) { ack(socket,message.id,message.motion_id,asFailure(error),message.action); }
}
app.register(async (instance) => { instance.get('/api/control', { websocket: true }, (socket: any, request: any) => {
  const user=findUserBySession(request.cookies[config.cookieName]); if(!user || !user.enabled) { sendJson(socket,{ok:false,code:'UNAUTHORIZED',msg:'Login required'}); socket.close(); return; }
  const state: ControlState={leaseId:null,enabled:false,closed:false,chain:Promise.resolve()}; controlSockets.add(socket);
  sendJson(socket,{web_v:1,type:'ready',data:{user:publicUser(user),robot:robot.getStatus()}});
  socket.on('message',(raw: any)=>{ state.chain=state.chain.then(()=>handleControlMessage(socket,state,user,raw.toString())).catch(error=>{ app.log.error(error,'control websocket handler failed'); }); });
  const cleanup=()=>{ if(state.closed)return; state.closed=true; controlSockets.delete(socket); state.chain=state.chain.catch(()=>{}).then(()=>releaseControl(state)); };
  socket.on('close',cleanup); socket.on('error',cleanup);
}); });
robot.on('message',(message: any)=>{ if(message.type==='response') return; for(const socket of controlSockets) sendJson(socket,{web_v:1,type:'robot_message',message}); });
robot.on('status',(status)=>{ for(const socket of controlSockets) sendJson(socket,{web_v:1,type:'robot_status',data:status}); });
app.get('/', async (_request, reply) => reply.sendFile('index.html'));
app.get('/session.js', async (_request, reply) => reply.sendFile('session.js'));
app.get('/bridge.js', async (_request, reply) => reply.sendFile('bridge.js'));
app.get('/console.html', { preHandler: requireAuth }, async (_request, reply) => reply.sendFile('console.html'));
app.get('/admin', { preHandler: roleGuard('admin') }, async (_request, reply) => reply.sendFile('admin.html'));

await ensureAdmin();
const envRobotTarget = readRobotConfig();
if (envRobotTarget) robot.connect({ ...envRobotTarget, profileName:'环境变量连接' }).catch((error) => app.log.error(error,'robot connection failed'));
await app.listen({host:config.host,port:config.port});
