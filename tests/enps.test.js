// eNPS survey trial. Harness mirrors tests/week2.test.js: temp DB via DB_PATH, fixture users, app.listen(0).
// No network: the payroll client is stubbed by replacing the methods on the shared `eh` object, which is
// the object services/survey.js holds a reference to.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pulse-enps-'));
process.env.DB_PATH=path.join(dir,'test.db');process.env.NODE_ENV='test';
process.env.ADMIN_EMAIL='test-admin@example.test';process.env.ADMIN_DEFAULT_PASSWORD='FixturePasswordOnly!';
process.env.SESSION_SECRET='fixture-session-only';process.env.ANTHROPIC_API_KEY='fixture';
// Graph must be OFF for these tests: the export is the implementation that has to work with nothing set.
delete process.env.GRAPH_TENANT_ID; delete process.env.GRAPH_CLIENT_ID;
delete process.env.GRAPH_CLIENT_SECRET; delete process.env.SURVEY_FROM_MAILBOX;
const db=require('../db/db'), bcrypt=require('bcryptjs');
const pass='FixturePasswordOnly!';
// Three operating centres: two big enough to report, one the size of Oran Park.
for(const [id,name] of [['a','Futuro Childcare & Education - Alpha'],['b','Futuro Childcare & Education - Beta'],['s','Futuro Childcare & Education - Small']])
  db.prepare('INSERT INTO centres(owna_id,name,capacity,opening,ll_id) VALUES(?,?,100,0,NULL)').run(id,name);
for(const role of ['viewer','centre','exec','ops_manager','admin'])
  db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role+'@example.test',role,bcrypt.hashSync(pass,4),role,role==='centre'?'a':null);

const cal=require('../services/calendar');
const survey=require('../services/survey');
const surveyMail=require('../services/survey-mail');
const surveyRoutes=require('../routes/survey');
const { eh }=require('../services/eh');

// Freeze the APP's clock only — never the global Date, which deadlocks the runner (see week2).
function freeze(iso,fn){
  cal.setNow(iso);
  const restore=()=>{ cal.setNow(null); };
  let out; try{ out=fn(); }catch(e){ restore(); throw e; }
  if(out&&typeof out.then==='function') return out.then((v)=>{restore();return v;},(e)=>{restore();throw e;});
  restore(); return out;
}
const FROZEN='2026-09-16T03:00:00Z', TODAY='2026-09-16'; // 1pm Sydney on the day of the owner's spec

// ---- Payroll stub ---------------------------------------------------------------------------------
// Employment Hero's location hierarchy: the organisation, then one node per centre, exactly the shape
// services/eh-talent.js walks.
const LOCATIONS=[{id:1,name:'Futuro Early Learning',parentId:null},
  {id:2,name:'Futuro Alpha',parentId:1},{id:3,name:'Futuro Beta',parentId:1},
  {id:4,name:'Futuro Small',parentId:1},{id:5,name:'Futuro HQ',parentId:1}];
const at=(centre)=>'Futuro Early Learning / '+centre;
function emp(id,centre,extra){ return Object.assign({id,emailAddress:'staff'+id+'@personal.example',primaryLocation:at(centre),status:'Active',startDate:'2025-01-06',endDate:null,employmentType:'Full Time'},extra||{}); }
// 6 at Alpha, 5 at Beta, 4 at Small, 2 at head office = 17 active, plus four who must NOT be invited.
const EMPLOYEES=[
  ...[11,12,13,14,15,16].map((i)=>emp(i,'Futuro Alpha')),
  ...[21,22,23,24,25].map((i)=>emp(i,'Futuro Beta')),
  ...[31,32,33,34].map((i)=>emp(i,'Futuro Small')),
  ...[41,42].map((i)=>emp(i,'Futuro HQ')),
  emp(51,'Futuro Alpha',{status:'Terminated',endDate:'2026-06-30'}),   // left
  emp(52,'Futuro Beta',{status:'Active',endDate:'2026-09-01'}),        // end date already past
  emp(53,'Futuro Beta',{status:'Active',endDate:'2026-12-01'}),        // leaving later — still staff today
  emp(54,'Futuro Small',{emailAddress:''}),                            // no address: counted, never a blank row
];
const ACTIVE_WITH_EMAIL=18; // 17 above + employee 53; employee 54 has no address
eh.allEmployees=async()=>EMPLOYEES.map((e)=>({...e}));
eh.locations=async()=>LOCATIONS.map((l)=>({...l}));
eh.hasCreds=()=>true;

const app=require('../server');
let server,base;
async function login(role){const r=await fetch(base+'/login',{method:'POST',body:new URLSearchParams({email:role+'@example.test',password:pass}),redirect:'manual'});assert.equal(r.status,302);return r.headers.get('set-cookie').split(';')[0];}
async function page(url,cookie){const r=await fetch(base+url,{headers:cookie?{cookie}:{},redirect:'manual'});assert.equal(r.status,200,url+' '+r.status);return r.text();}

test('eNPS survey trial',async(t)=>{
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 try {

 // ===== The arithmetic =====
 await t.test('eNPS is promoters minus detractors, with the passive band in the denominator only',()=>{
  // 9 and 10 promote, 0-6 detract, 7 and 8 are passive.
  assert.deepEqual(survey.enps([10,10,9,9]), {n:4,promoters:4,passives:0,detractors:0,enps:100});
  assert.deepEqual(survey.enps([0,1,6]),      {n:3,promoters:0,passives:0,detractors:3,enps:-100});
  // All passives: nobody promotes, nobody detracts, and the score is 0 rather than undefined. This is
  // the band people get wrong — a 7 is not a mild promoter and an 8 is not neutral-and-excluded.
  assert.deepEqual(survey.enps([7,8,7,8]),    {n:4,promoters:0,passives:4,detractors:0,enps:0});
  // 10 answers: 5 promoters, 2 passives, 3 detractors -> 50 - 30 = 20. The passives are in the
  // denominator: drop them and the same answers would read 62 - 38 = 24.
  const mixed=[10,10,9,9,9,8,7,6,3,0];
  assert.deepEqual(survey.enps(mixed), {n:10,promoters:5,passives:2,detractors:3,enps:20});
  // A 6 detracts and a 7 does not — the boundary the definition turns on.
  assert.equal(survey.enps([6]).detractors,1);
  assert.equal(survey.enps([7]).detractors,0);
  assert.equal(survey.enps([7]).passives,1);
  assert.equal(survey.enps([8]).promoters,0);
  assert.equal(survey.enps([9]).promoters,1);
  // Rounded to a whole number, and no answers is no score rather than zero.
  assert.equal(survey.enps([10,10,0]).enps, 33);   // 66.67 - 33.33
  assert.equal(survey.enps([]).enps, null);
  // Anything outside 0..10 is not an eNPS answer and is dropped rather than skewing the denominator.
  // Number(null) is 0 and a 0 is a detractor, so a missing value must be dropped rather than coerced.
  assert.equal(survey.enps([10,11,-1,'x',null,undefined,false,'']).n, 1);
  assert.equal(survey.enps([10,null,null]).detractors, 0);
 });

 await t.test('the three questions are the owner\'s, verbatim, and only the first is required',()=>{
  const q=survey.questions('Austral');
  assert.equal(q[0].text,'How likely are you to recommend Futuro Austral?');
  assert.equal(q[1].text,'What is the reason for your score?');
  assert.equal(q[2].text,'Any other feedback you would like to add?');
  assert.deepEqual(q.map((x)=>x.required),[true,false,false]);
  // The centre in question 1 is the RESPONDENT'S OWN centre, so the label comes off the centre name.
  assert.equal(survey.centreLabel('Futuro Childcare & Education - Gledswood Hills'),'Gledswood Hills');
  assert.equal(survey.centreLabel('Futuro Childcare & Education Cobbitty'),'Cobbitty');
 });

 // ===== The export =====
 let round, exported;
 await t.test('a round can be created and the export has one row per active staff member',async()=>{
  round=await freeze(FROZEN,()=>survey.createRound({name:'eNPS trial — September 2026',opens_on:TODAY,closes_on:'2026-09-30'}));
  assert.equal(survey.roundState(round,TODAY),'open');
  exported=await freeze(FROZEN,()=>survey.exportRows(round.id,{baseUrl:'https://pulse.example'}));
  assert.equal(exported.rows.length,ACTIVE_WITH_EMAIL,'one row per active staff member with an address');
  assert.equal(exported.noEmail,1,'the staff member with no address is counted, not silently dropped');
  // Nobody who has left, and nobody twice.
  const emails=exported.rows.map((r)=>r.email);
  assert.equal(new Set(emails).size,emails.length);
  assert.ok(!emails.includes('staff51@personal.example'),'a terminated staff member must not be invited');
  assert.ok(!emails.includes('staff52@personal.example'),'someone whose end date has passed must not be invited');
  assert.ok(emails.includes('staff53@personal.example'),'someone leaving later is still staff today');
  // Every row carries a working magic link and the respondent's own centre.
  for(const r of exported.rows){
   assert.match(r.link,/^https:\/\/pulse\.example\/s\/[A-Za-z0-9_-]{20,}$/);
   assert.ok(['Alpha','Beta','Small','Early Learning'].includes(r.centre),'unexpected centre label '+r.centre);
   assert.equal(survey.tokenState(r.token,TODAY).state,'open');
  }
  // The question each person is asked names THEIR centre.
  const alpha=exported.rows.find((r)=>r.email==='staff11@personal.example');
  assert.equal(alpha.centre,'Alpha');
  assert.equal(survey.tokenState(alpha.token,TODAY).questions[0].text,'How likely are you to recommend Futuro Alpha?');
  // A payroll location that is not a centre still gets asked — about Futuro itself.
  const hq=exported.rows.find((r)=>r.email==='staff41@personal.example');
  assert.equal(hq.centre,'Early Learning');
  assert.equal(survey.tokenState(hq.token,TODAY).questions[0].text,'How likely are you to recommend Futuro Early Learning?');
 });

 await t.test('no email address is written to the database, anywhere',()=>{
  // Walk every table and every column in the file — sqlite_master, not a hard-coded list, so a table
  // added later is covered too — and look for anything shaped like one of the fixture addresses.
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r)=>r.name);
  const addresses=EMPLOYEES.map((e)=>e.emailAddress).filter(Boolean);
  let scanned=0;
  for(const t of tables){
   const cols=db.prepare(`PRAGMA table_info(${t})`).all().map((c)=>c.name);
   for(const row of db.prepare(`SELECT * FROM ${t}`).all()){
    for(const c of cols){
     const v=row[c]; if(v==null) continue;
     const s=String(v); scanned++;
     for(const a of addresses) assert.ok(!s.includes(a),`${t}.${c} contains the address ${a}`);
     // And nothing that merely looks like a personal address either — a stored hash of one would
     // still be a link back to a person, so the shape is banned outright in these two tables.
     if(t.startsWith('survey_')) assert.ok(!/@/.test(s),`${t}.${c} holds something address-shaped: ${s}`);
    }
   }
  }
  assert.ok(scanned>0,'the scan found no rows at all, so it proved nothing');
  // The invitation table holds a token, a round, a centre, two round-wide dates and a spent flag.
  // Nothing else, and in particular no date that varies from respondent to respondent — see the
  // severing test below for why a day of use would be enough to undo all of this.
  assert.deepEqual(db.prepare('PRAGMA table_info(survey_invitations)').all().map((c)=>c.name),
    ['token','round_id','owna_id','centre_label','issued_on','sent_on','used']);
 });

 await t.test('generating the export again hands the same person the same link',async()=>{
  const again=await freeze(FROZEN,()=>survey.exportRows(round.id,{baseUrl:'https://pulse.example'}));
  assert.equal(again.rows.length,exported.rows.length,'no second batch of tokens was minted');
  for(const r of again.rows){
   const first=exported.rows.find((x)=>x.email===r.email);
   assert.equal(r.token,first.token,'the reminder must reach '+r.centre+' staff with the link they already have');
  }
 });

 await t.test('the token-to-person map cannot be rebuilt from the database and payroll',async()=>{
  // The attack, run for real. Throw the mail-merge file away and rebuild the mapping from the only two
  // things left, both of which anyone holding a copy of this database also has: the invitation rows in
  // it, and the same payroll call the export itself makes. If a centre's tokens are handed out by
  // POSITION — staff in payroll-id order against invitations in rowid order — this reconstructs every
  // row, and an invitation's ordinal within its centre is exactly the employee id the schema says the
  // table does not hold. No kept file needed, and the free text goes with it.
  const { staff }=await freeze(FROZEN,()=>survey.activeStaff({today:TODAY}));
  assert.equal(staff.length,ACTIVE_WITH_EMAIL,'the reconstruction must start from the export\'s own staff list');
  const truthFor=(p)=>exported.rows.find((x)=>x.email===p.email).token;
  const taken=new Map(); const guessed=new Map(); let hits=0;
  for(const p of staff){                       // activeStaff returns them in payroll-id order, as the export uses them
   const k=p.owna_id==null?'':p.owna_id;
   const i=taken.get(k)||0; taken.set(k,i+1);
   const pool=db.prepare('SELECT token FROM survey_invitations WHERE round_id=? AND owna_id IS ? ORDER BY rowid').all(round.id,p.owna_id);
   if(!guessed.has(k)) guessed.set(k,{guess:[],truth:[]});
   guessed.get(k).guess.push(pool[i]&&pool[i].token);
   guessed.get(k).truth.push(truthFor(p));
   if(pool[i]&&pool[i].token===truthFor(p)) hits++;
  }
  assert.ok(hits<staff.length,
    `position rebuilt ${hits} of ${staff.length} invitations from the database and payroll alone — an invitation's place in its centre is a stored employee id`);
  // And not just "not all of them": a centre that reconstructs whole is wholly exposed, so the two
  // six-person centres — the ones where a guess is not near-even odds — must not come out in order.
  for(const k of ['a','b']){
   assert.equal(guessed.get(k).truth.length,6);
   assert.notDeepEqual(guessed.get(k).guess,guessed.get(k).truth,'centre '+k+' reconstructs in payroll order');
  }
  // The pairing is keyed, so it lives outside this file: nothing stored may reproduce it. The column
  // list is pinned above — a slot column, or these rows ordered by who they were issued for, puts the
  // identifier straight back. What is left here is a pool and a set of people, and no way across.
  assert.equal(db.prepare('SELECT COUNT(DISTINCT token) n FROM survey_invitations WHERE round_id=?').get(round.id).n,ACTIVE_WITH_EMAIL);
 });

 // ===== The magic link =====
 await t.test('the magic link needs no login',async()=>{
  surveyRoutes.resetRateLimit();
  const tok=exported.rows.find((r)=>r.centre==='Alpha').token;
  // No cookie at all — not even a session. A 302 to /login would mean requireLogin caught it.
  const r=await freeze(FROZEN,()=>fetch(base+'/s/'+tok,{redirect:'manual'}));
  assert.equal(r.status,200);
  const html=await r.text();
  assert.match(html,/How likely are you to recommend Futuro Alpha\?/);
  assert.match(html,/What is the reason for your score\?/);
  assert.match(html,/Any other feedback you would like to add\?/);
  assert.match(html,/anonymous/i);
  // The token is in the URL, so the page must not leak it to another site or be indexed.
  assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  assert.match(r.headers.get('x-robots-tag')||'',/noindex/);
  assert.match(r.headers.get('cache-control')||'',/no-store/);
  // And it must not carry the dashboard's navigation to someone who is not a dashboard user.
  assert.doesNotMatch(html,/People &amp; Culture<\/a>|Wages &amp; Margin/);
 });

 await t.test('a token works once and then does not',async()=>{
  surveyRoutes.resetRateLimit();
  const tok=exported.rows.find((r)=>r.centre==='Beta').token;
  const post=(body)=>freeze(FROZEN,()=>fetch(base+'/s/'+tok,{method:'POST',body:new URLSearchParams(body),redirect:'manual'}));
  const first=await post({score:'9',reason:'Good team.',other:''});
  assert.equal(first.status,200);
  assert.match(await first.text(),/Thank you/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_responses').get().n,1);
  // Second use: the friendly page, and NO second answer.
  const second=await post({score:'0',reason:'Trying again.',other:''});
  assert.equal(second.status,200);
  assert.match(await second.text(),/isn’t open|isn't open/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_responses').get().n,1,'a spent token must not be able to vote twice');
  // And the page for it now looks exactly like a link that never existed.
  const get=await freeze(FROZEN,()=>fetch(base+'/s/'+tok,{redirect:'manual'}));
  assert.equal(get.status,200);
  assert.match(await get.text(),/isn’t open|isn't open/);
 });

 await t.test('an unknown token and a closed round both give the same friendly page',async()=>{
  surveyRoutes.resetRateLimit();
  const closed=await freeze(FROZEN,()=>survey.createRound({name:'Last quarter',opens_on:'2026-06-01',closes_on:'2026-06-30'}));
  const closedTok=survey.newToken();
  db.prepare('INSERT INTO survey_invitations (token,round_id,owna_id,centre_label,issued_on) VALUES (?,?,?,?,?)').run(closedTok,closed.id,'a','Alpha','2026-06-01');
  assert.equal(survey.roundState(closed,TODAY),'closed');

  const bodies=[];
  for(const tok of ['thisTokenWasNeverIssuedAtAll000',closedTok]){
   const r=await freeze(FROZEN,()=>fetch(base+'/s/'+tok,{redirect:'manual'}));
   assert.equal(r.status,200,'a bad link is a friendly page, not an error status');
   const html=await r.text();
   assert.match(html,/isn’t open|isn't open/);
   assert.doesNotMatch(html,/expired|already been used by|no such|invalid|unknown/i,'the page must not say WHICH it was');
   bodies.push(html);
  }
  // Byte-identical: an unknown token and a closed round are indistinguishable from the outside, so the
  // route cannot be used to find out which tokens exist or who has already answered.
  assert.equal(bodies[0],bodies[1]);
  // Posting to the closed round writes nothing.
  const before=db.prepare('SELECT COUNT(*) n FROM survey_responses').get().n;
  const p=await freeze(FROZEN,()=>fetch(base+'/s/'+closedTok,{method:'POST',body:new URLSearchParams({score:'10'}),redirect:'manual'}));
  assert.equal(p.status,200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_responses').get().n,before);
  // A round that has not opened yet is the same page again.
  const later=await freeze(FROZEN,()=>survey.createRound({name:'Next quarter',opens_on:'2026-12-01',closes_on:'2026-12-14'}));
  assert.equal(survey.roundState(later,TODAY),'upcoming');
 });

 await t.test('the public route is rate-limited',async()=>{
  surveyRoutes.resetRateLimit();
  let limited=0;
  for(let i=0;i<12;i++){
   const r=await freeze(FROZEN,()=>fetch(base+'/s/aTokenThatDoesNotExistAtAll1',{method:'POST',body:new URLSearchParams({score:'10'}),redirect:'manual'}));
   if(r.status===429) limited++;
   await r.text();
  }
  assert.ok(limited>0,'a public route that writes must refuse a flood');
  surveyRoutes.resetRateLimit();
 });

 await t.test('a whole centre answering from one connection is not turned away',async()=>{
  surveyRoutes.resetRateLimit();
  // The bucket used to be the client ADDRESS, so a cap of ten posts meant the eleventh answer in ten
  // minutes was refused — and an address is shared twice over: 57 staff at Austral answer on the
  // centre's one wifi, and behind Cloudflare the address the app sees is the CDN's edge, not the
  // respondent's, so all 221 staff landed in a handful of buckets. Twelve people, one address, one
  // round: every one of them must get through, because one token is one respondent.
  //
  // Its own round, so the counts the reporting tests below assert on are untouched. It opens in
  // November, after every other frozen date here, so currentRound() on 16 September is unchanged.
  const OPEN='2026-11-02', WHEN=OPEN+'T03:00:00Z';
  const r3=await freeze(WHEN,()=>survey.createRound({name:'eNPS trial — November 2026',opens_on:OPEN,closes_on:'2026-11-16'}));
  const ex3=await freeze(WHEN,()=>survey.exportRows(r3.id,{baseUrl:'https://pulse.example'}));
  const crowd=ex3.rows.filter((x)=>x.centre==='Alpha'||x.centre==='Beta').map((x)=>x.token);
  assert.equal(crowd.length,12,'the fixture needs more respondents than the old per-address cap of 10');
  const before=db.prepare('SELECT COUNT(*) n FROM survey_responses').get().n;
  for(const [i,tok] of crowd.entries()){
   const r=await freeze(WHEN,()=>fetch(base+'/s/'+tok,{method:'POST',body:new URLSearchParams({score:'9',reason:'november '+i}),redirect:'manual'}));
   assert.equal(r.status,200,'respondent '+(i+1)+' of 12 on the same connection was refused');
   assert.match(await r.text(),/Thank you/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_responses').get().n,before+12,'answers were dropped by the rate limit');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_invitations WHERE round_id=? AND used=1').get(r3.id).n,12);
  // Merely opening the link is the same story: every one of them can read the page first.
  for(const tok of crowd){
   const r=await freeze(WHEN,()=>fetch(base+'/s/'+tok,{redirect:'manual'}));
   assert.notEqual(r.status,429,'opening a link from a shared connection must not be throttled'); await r.text();
  }
 });

 await t.test('a throttled respondent is told to wait, not that their link is spent',async()=>{
  surveyRoutes.resetRateLimit();
  // The per-token cap is the one that bites a real person — a mistyped score, a double tap. When it
  // does, the page must not be the one for a link that is already used: the token is still unspent,
  // and someone told their link is dead does not come back, so the round loses them silently.
  const tok='aTokenThatDoesNotExistAtAll2';
  let busy=null;
  for(let i=0;i<8&&!busy;i++){
   const r=await freeze(FROZEN,()=>fetch(base+'/s/'+tok,{method:'POST',body:new URLSearchParams({score:'10'}),redirect:'manual'}));
   const html=await r.text();
   if(r.status===429) busy={r,html};
  }
  assert.ok(busy,'the per-token cap must refuse a repeated post');
  assert.match(busy.html,/Your link still works/,'a throttled respondent must be told their link is still good');
  assert.match(busy.html,/wait a few minutes/);
  assert.doesNotMatch(busy.html,/isn’t open|isn't open|already been used/,'the throttle must not wear the spent-link page');
  assert.equal(busy.r.headers.get('retry-after'),String(10*60));
  // And the throttle still says nothing about whether the token exists: a real, open token throttles
  // to the same page.
  surveyRoutes.resetRateLimit();
  const real=exported.rows.find((r)=>r.centre==='Alpha').token;
  let realBusy=null;
  for(let i=0;i<8&&!realBusy;i++){
   const r=await freeze(FROZEN,()=>fetch(base+'/s/'+real,{method:'POST',body:new URLSearchParams({score:'not-a-score'}),redirect:'manual'}));
   const html=await r.text();
   if(r.status===429) realBusy=html;
  }
  assert.ok(realBusy,'a real token is throttled too');
  assert.equal(realBusy,busy.html,'the busy page must be the same whether or not the token exists');
  assert.equal(survey.tokenState(real,TODAY).state,'open','being throttled must not spend the token');
  surveyRoutes.resetRateLimit();
 });

 await t.test('the address bucket keys on the respondent, not on the proxy in front of it',async()=>{
  // `trust proxy 1` strips the hop Render appends, which is Cloudflare's edge — so req.ip alone is the
  // CDN for every respondent in the country. The wide flood cap has to key on cf-connecting-ip.
  const keep=process.env.SURVEY_RATE_GETS;
  process.env.SURVEY_RATE_GETS='3';
  try {
   surveyRoutes.resetRateLimit();
   const get=(addr)=>freeze(FROZEN,()=>fetch(base+'/s/thisTokenWasNeverIssuedAtAll000',{headers:{'cf-connecting-ip':addr},redirect:'manual'}));
   let last;
   for(let i=0;i<4;i++){ last=await get('203.0.113.9'); await last.text(); }
   assert.equal(last.status,429,'one address past the flood cap must be refused');
   // Every one of these requests reaches the app from 127.0.0.1: if the bucket were req.ip, this
   // second respondent would be refused along with the first.
   const other=await get('203.0.113.10'); await other.text();
   assert.notEqual(other.status,429,'a different respondent behind the same proxy shares no bucket');
  } finally {
   if(keep===undefined) delete process.env.SURVEY_RATE_GETS; else process.env.SURVEY_RATE_GETS=keep;
   surveyRoutes.resetRateLimit();
  }
 });

 // ===== The severing =====
 let alphaTokens;
 await t.test('an answer cannot be traced back to an invitation',async()=>{
  surveyRoutes.resetRateLimit();
  // Five people at Alpha answer, deliberately NOT in the order their invitations were created. The
  // order is picked over the pool's OWN rowid order, so "not in creation order" is true by
  // construction — pick it over the export's rows instead and, now that the two orders differ, the
  // scramble can land back on creation order by luck and assertion 4 below passes for the wrong reason.
  alphaTokens=db.prepare("SELECT token FROM survey_invitations WHERE round_id=? AND owna_id='a' ORDER BY rowid").all(round.id).map((r)=>r.token);
  const order=[4,2,0,3,1], scores=[10,9,8,7,0];
  for(let i=0;i<order.length;i++){
   const r=await freeze(FROZEN,()=>fetch(base+'/s/'+alphaTokens[order[i]],{method:'POST',body:new URLSearchParams({score:String(scores[i]),reason:'answer '+i}),redirect:'manual'}));
   assert.equal(r.status,200); await r.text();
  }

  // 1. No foreign key, and the only columns the two tables share are the round and the centre — group
  //    attributes, not a joining value.
  assert.equal(db.prepare('PRAGMA foreign_key_list(survey_responses)').all().length,0);
  const invCols=db.prepare('PRAGMA table_info(survey_invitations)').all().map((c)=>c.name);
  const respCols=db.prepare('PRAGMA table_info(survey_responses)').all().map((c)=>c.name);
  assert.deepEqual(invCols.filter((c)=>respCols.includes(c)).sort(),['centre_label','owna_id','round_id']);

  // 2. No token, and no invitation rowid, appears anywhere in the responses.
  const tokens=new Set(db.prepare('SELECT token FROM survey_invitations').all().map((r)=>r.token));
  for(const row of db.prepare('SELECT rowid AS rid, * FROM survey_responses').all())
   for(const v of Object.values(row)) assert.ok(!tokens.has(String(v)),'a response carries a token');

  // 3. Time cannot line the two tables up. The response side stores a DAY, never an instant, and the
  //    invitation side stores no time of use at all — only that the token is spent.
  for(const r of db.prepare('SELECT used FROM survey_invitations WHERE used <> 0').all())
   assert.equal(r.used,1,'a spent invitation records a flag, never when it was spent');
  for(const r of db.prepare('SELECT submitted_on FROM survey_responses').all())
   assert.match(r.submitted_on,/^\d{4}-\d{2}-\d{2}$/,'submitted_on must be a day, not an instant');

  // 4. And the invitation rowid is no substitute for a timestamp: it is assigned when the round is
  //    generated, not when the token is spent. Pairing the two tables in their own natural order gets
  //    the wrong answer, which is the whole point.
  const usedInOrder=db.prepare("SELECT token FROM survey_invitations WHERE round_id=? AND owna_id='a' AND used=1 ORDER BY rowid").all(round.id).map((r)=>r.token);
  const truth=order.map((i)=>alphaTokens[i]);
  assert.notDeepEqual(usedInOrder,truth,'rowid order must not reproduce the order people answered in');

  // 5. The proof itself: from the database alone, every Alpha response is equally consistent with
  //    every Alpha invitation that was spent. Five candidates for each of five answers — nobody,
  //    including an administrator holding this file, can say which person wrote which.
  const alphaResponses=db.prepare("SELECT * FROM survey_responses WHERE round_id=? AND owna_id='a'").all(round.id);
  assert.equal(alphaResponses.length,5);
  for(const resp of alphaResponses){
   const candidates=db.prepare(`SELECT token FROM survey_invitations
     WHERE round_id=? AND owna_id IS ? AND used=1`).all(resp.round_id,resp.owna_id);
   assert.equal(candidates.length,5,'an answer must not narrow to fewer invitations than were spent');
  }
 });

 await t.test('a round spread over a fortnight is severed just as hard',async()=>{
  surveyRoutes.resetRateLimit();
  // The five Alpha answers above all land on ONE frozen day, which is the single shape in which a day on
  // the invitation side looks harmless. A real round is open for a fortnight, and people answer when they
  // read the email. So: a second round, its own tokens, and five Alpha staff answering on five different
  // days — one person per centre per day, which is the ordinary case, not a contrived one. If the
  // invitation side recorded the day a token was spent, (round, centre, day) would return exactly ONE
  // invitation for each of these answers, and the mail-merge file the admin page says to keep turns that
  // token into a name.
  const OPEN='2026-10-01';
  const r2=await freeze(OPEN+'T03:00:00Z',()=>survey.createRound({name:'eNPS trial — October 2026',opens_on:OPEN,closes_on:'2026-10-15'}));
  const ex2=await freeze(OPEN+'T03:00:00Z',()=>survey.exportRows(r2.id,{baseUrl:'https://pulse.example'}));
  const alpha=ex2.rows.filter((x)=>x.centre==='Alpha').map((x)=>x.token);
  const days=['2026-10-02','2026-10-05','2026-10-07','2026-10-09','2026-10-14'];
  for(const [i,day] of days.entries()){
   const r=await freeze(day+'T03:00:00Z',()=>fetch(base+'/s/'+alpha[i],{method:'POST',body:new URLSearchParams({score:String([10,9,8,7,0][i]),reason:'october '+i}),redirect:'manual'}));
   assert.equal(r.status,200); await r.text();
  }
  // Exactly one Alpha answer on each of those days: the shape in which a day is a name.
  for(const day of days)
   assert.equal(db.prepare("SELECT COUNT(*) n FROM survey_responses WHERE round_id=? AND owna_id='a' AND submitted_on=?").get(r2.id,day).n,1);

  // NO column of the invitation table may split a centre's invitations by the day an answer was
  // submitted: matching any column against a response's day must return either nothing or the whole
  // centre. A used_on returns one, which is the defect this guards.
  const invCols=db.prepare('PRAGMA table_info(survey_invitations)').all().map((c)=>c.name);
  for(const resp of db.prepare('SELECT * FROM survey_responses WHERE round_id=?').all(r2.id)){
   const total=db.prepare('SELECT COUNT(*) n FROM survey_invitations WHERE round_id=? AND owna_id IS ?').get(r2.id,resp.owna_id).n;
   for(const c of invCols){
    const n=db.prepare(`SELECT COUNT(*) n FROM survey_invitations WHERE round_id=? AND owna_id IS ? AND "${c}" = ?`)
      .get(r2.id,resp.owna_id,resp.submitted_on).n;
    assert.ok(n===0||n===total,`survey_invitations.${c} narrows the ${resp.submitted_on} answer to ${n} of ${total} invitations`);
   }
  }
  // Every one of the five answers is still consistent with every spent Alpha invitation, days apart or not.
  const spent=db.prepare("SELECT token FROM survey_invitations WHERE round_id=? AND owna_id='a' AND used=1").all(r2.id);
  assert.equal(spent.length,days.length);
  // And the counting the flag has to keep doing: the response rate is the whole reason `used` exists.
  const res2=survey.results(r2.id,{today:'2026-10-14'});
  const alphaRow=res2.centres.find((c)=>c.label==='Alpha');
  assert.equal(alphaRow.invited,6);
  assert.equal(alphaRow.responses,5);
  assert.equal(alphaRow.response_rate,83.3);
  const counts=db.prepare('SELECT COUNT(*) invited, SUM(used) used FROM survey_invitations WHERE round_id=?').get(r2.id);
  assert.equal(counts.invited,ACTIVE_WITH_EMAIL);
  assert.equal(counts.used,days.length,'the admin page counts answers off the flag');
 });

 await t.test('strip the token and a centre\'s invitations are two kinds of row: spent and not',()=>{
  // The test above catches a column that holds a response's DAY, because it matches each column
  // against submitted_on. It would NOT catch the same fact written in another shape — an instant, an
  // epoch, a counter of the order people answered — since matching '2026-10-02' against those returns
  // nothing and the assertion passes for the wrong reason. Each of those re-identifies just as well:
  // order the spent invitations by a sequence and order the answers by id, and the two lists line up.
  //
  // So state the invariant the guarantee actually rests on, over every round in the database rather
  // than the one the previous test built. Within a centre the only column that may vary is the token;
  // the spent flag may take the two values a flag has and no others. Drop the token and what is left
  // of a centre's rows must collapse to at most TWO distinct tuples — spent, and not spent. A column
  // that tells two respondents apart is a per-respondent value whatever its type, and a per-respondent
  // value on this side of the severing is a name. used_on gave one tuple per person who had answered.
  const cols=db.prepare('PRAGMA table_info(survey_invitations)').all().map((c)=>c.name);
  const rest=cols.filter((c)=>c!=='token');
  // Every round that issued invitations, not every round: the closed-round test above creates one that
  // was never exported, and an empty round proves nothing either way.
  const allRounds=db.prepare('SELECT DISTINCT round_id AS id FROM survey_invitations ORDER BY round_id').all();
  assert.ok(allRounds.length>=2,'both invited rounds must be in the database, or this proves nothing');
  let checked=0;
  for(const r of allRounds){
   const centres=db.prepare('SELECT DISTINCT owna_id FROM survey_invitations WHERE round_id=?').all(r.id);
   for(const c of centres){
    const rows=db.prepare('SELECT * FROM survey_invitations WHERE round_id=? AND owna_id IS ?').all(r.id,c.owna_id);
    // The flag must BE a flag. Widen it to a day, an instant or a sequence number and a centre where
    // only one person has answered would still collapse to two tuples, so say this outright.
    for(const row of rows)
     assert.ok(row.used===0||row.used===1,`survey_invitations.used holds ${JSON.stringify(row.used)} — that is not a flag`);
    const shapes=new Set(rows.map((row)=>JSON.stringify(rest.map((k)=>row[k]))));
    assert.ok(shapes.size<=2,
      `round ${r.id}, centre ${c.owna_id}: ${rows.length} invitations take ${shapes.size} distinct shapes `
      +`once the token is removed — a column past the spent flag is telling respondents apart`);
    checked+=rows.length;
   }
  }
  assert.equal(checked,db.prepare('SELECT COUNT(*) n FROM survey_invitations').get().n,
    'the scan missed invitations, so it proved less than it says');
  assert.ok(checked>=ACTIVE_WITH_EMAIL*2,'both rounds\' invitations must be in the scan');
 });

 // ===== Reporting =====
 await t.test('the five-response threshold hides a small centre and still counts it in the group',async()=>{
  surveyRoutes.resetRateLimit();
  // Small has four staff, like Oran Park. Two of them answer: below the threshold, and both are
  // detractors, so if the rule leaked their answers out of the group figure it would be obvious.
  const small=exported.rows.filter((r)=>r.centre==='Small').map((r)=>r.token);
  for(const [i,tok] of [small[0],small[1]].entries()){
   const r=await freeze(FROZEN,()=>fetch(base+'/s/'+tok,{method:'POST',body:new URLSearchParams({score:'0',reason:'small centre '+i}),redirect:'manual'}));
   assert.equal(r.status,200); await r.text();
  }
  const res=survey.results(round.id,{today:TODAY});
  assert.equal(res.min_responses,5);
  const row=(label)=>res.centres.find((c)=>c.label===label);

  // Alpha: five answers (10,9,8,7,0) -> 40% promote, 20% detract -> 20.
  assert.equal(row('Alpha').responses,5);
  assert.equal(row('Alpha').reportable,true);
  assert.equal(row('Alpha').enps,20);

  // Small: two answers, so no figure at all — not the score, not the bands.
  assert.equal(row('Small').reportable,false);
  assert.equal(row('Small').enps,null);
  assert.equal(row('Small').promoters,null);
  assert.equal(row('Small').detractors,null);
  // Beta (1 answer), Small and the group bucket are all below it. Small's two answers are filed under
  // the group bucket, because a four-person centre can never be reported — see the test after next.
  assert.equal(res.withheld,3);
  assert.equal(row('Early Learning').reportable,false);
  assert.equal(row('Early Learning').responses,2);

  // ...and those two answers are still in the group figure. Group is 5 Alpha + 1 Beta (a 9) + 2 Small
  // zeros = 8 answers: promoters 10,9,9 = 3, detractors 0,0,0 = 3, passives 8,7 = 2 -> 37.5-37.5 = 0.
  assert.equal(res.group.n,8);
  assert.equal(res.group.promoters,3);
  assert.equal(res.group.passives,2);
  assert.equal(res.group.detractors,3);
  assert.equal(res.group.enps,0);
  // Drop the two withheld answers and the same data would read 3/6 - 1/6 = +33. Folding them in is
  // what the owner asked for, and this is the number that proves it happened.
  assert.notEqual(res.group.enps,33);
  assert.equal(res.group.invited,ACTIVE_WITH_EMAIL);
  assert.equal(res.group.response_rate,Math.round(8/ACTIVE_WITH_EMAIL*1000)/10);
 });

 await t.test('a withheld centre publishes nothing that gives its response count back',async()=>{
  // The threshold was cosmetic: the page printed "<5" beside the invited count and the response rate,
  // and invited x rate is the count exactly — four invited at 50% reads "two of these four named
  // people answered". The rate is rounded to 0.1%, which is a bijection onto the count at every
  // headcount Futuro has, so it is not a near miss. Both halves of the pair have to go.
  const res=survey.results(round.id,{today:TODAY});
  for(const c of res.centres.filter((x)=>!x.reportable)){
   assert.equal(c.invited,null,c.label+': an invited count beside a rate rebuilds the withheld count');
   assert.equal(c.response_rate,null,c.label+': a rate beside an invited count rebuilds the withheld count');
  }
  // A reportable centre still carries both — the fix must withhold, not blank the page.
  const alpha=res.centres.find((c)=>c.label==='Alpha');
  assert.equal(alpha.invited,6);
  assert.equal(alpha.response_rate,83.3);

  // And on the page itself. /pc has no role gate beyond requireLogin, so a plain viewer renders this.
  const viewerCookie=await login('viewer');
  const html=await freeze(FROZEN,()=>page('/pc?metric=enps',viewerCookie));
  const rowOf=(label)=>{const m=html.match(new RegExp('<tr>\\s*<td>'+label+'</td>[\\s\\S]*?</tr>'));assert.ok(m,'no row for '+label);return m[0];};
  const small=rowOf('Small');
  assert.match(small,/&lt;5/,'the row must still say too few responses to report');
  assert.doesNotMatch(small,/>\s*4\s*</,'the invited count is printed for a withheld centre');
  assert.doesNotMatch(small,/%/,'a response rate is printed for a withheld centre');
  assert.match(rowOf('Alpha'),/83\.3%/,'a reportable centre still shows its rate');
 });

 await t.test('a centre too small to ever be reported is not written onto the answer',()=>{
  // Small has four staff, like Oran Park: it can never reach a five-response threshold, so no
  // per-centre figure will ever be published for it. Tagging its answers with it therefore buys
  // nothing, and costs the guarantee — the stored row would read "one of these four named people
  // wrote this" to anyone holding the file. The answer goes to the group bucket, where it still counts.
  const rows=db.prepare("SELECT owna_id, centre_label FROM survey_responses WHERE reason LIKE 'small centre%'").all();
  assert.equal(rows.length,2);
  for(const r of rows){
   assert.equal(r.owna_id,null,'a four-person centre must not be written onto an answer');
   assert.equal(r.centre_label,survey.NO_CENTRE_LABEL);
  }
  // Stated as the rule rather than the fixture: no centre invited fewer than MIN_RESPONSES people
  // appears on a stored response anywhere in the file.
  const tooSmall=db.prepare('SELECT round_id, owna_id FROM survey_invitations GROUP BY round_id, owna_id HAVING COUNT(*) < ?')
    .all(survey.MIN_RESPONSES).filter((r)=>r.owna_id!=null);
  assert.ok(tooSmall.length,'the fixture must contain a centre below the threshold, or this proves nothing');
  for(const r of tooSmall)
   assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_responses WHERE round_id = ? AND owna_id = ?').get(r.round_id,r.owna_id).n,0,
     'centre '+r.owna_id+' has too few people to report and is on a stored answer');
  // A centre big enough to report keeps its centre, or per-centre reporting would not work at all.
  assert.ok(db.prepare("SELECT COUNT(*) n FROM survey_responses WHERE owna_id='a'").get().n>=5);
 });

 await t.test('the exact per-centre numbers are on the admin page, which is admin/ops only',async()=>{
  const adminCookie=await login('admin');
  const html=await freeze(FROZEN,()=>page('/admin/survey?round='+round.id,adminCookie));
  const m=html.match(/<tr>\s*<td>Small<\/td>[\s\S]*?<\/tr>/);
  assert.ok(m,'the chase-up table must name every centre, including the small ones');
  assert.match(m[0],/>4</,'invited');
  assert.match(m[0],/>2</,'answered');
  assert.match(m[0],/50%/,'response rate');
  // And it is not reachable without the role: the route is requireAdminOrOps.
  const viewerCookie=await login('viewer');
  const r=await freeze(FROZEN,()=>fetch(base+'/admin/survey?round='+round.id,{headers:{cookie:viewerCookie},redirect:'manual'}));
  assert.equal(r.status,403); await r.text();
 });

 await t.test('the free text is group level, and carries no centre',()=>{
  const c=survey.comments(round.id);
  assert.ok(c.length>=6);
  for(const row of c){
   assert.deepEqual(Object.keys(row).sort(),['other','reason','score','submitted_on']);
   assert.ok(!('owna_id' in row) && !('centre_label' in row),'a comment must not arrive with its centre');
  }
 });

 // ===== Who may see what =====
 await t.test('a centre-scoped user sees only their own centre\'s result',async()=>{
  const centreCookie=await login('centre'); // scoped to 'a' = Alpha
  const html=await freeze(FROZEN,()=>page('/pc?metric=enps',centreCookie));
  assert.match(html,/eNPS survey/);
  assert.match(html,/Alpha/);
  assert.doesNotMatch(html,/Beta/,'a centre user must not see another centre on the page');
  assert.doesNotMatch(html,/>Small</,'nor a third centre');
  // Free text is admin/ops only, and this user is neither.
  assert.doesNotMatch(html,/What people wrote/);
  // The service enforces it too, not just the view.
  const scoped=survey.results(round.id,{scoped:'a',today:TODAY});
  assert.equal(scoped.centres.length,1);
  assert.equal(scoped.centres[0].label,'Alpha');
 });

 await t.test('exec sees every centre; admin and ops also see the free text',async()=>{
  const execCookie=await login('exec');
  const execHtml=await freeze(FROZEN,()=>page('/pc?metric=enps',execCookie));
  assert.match(execHtml,/Alpha/); assert.match(execHtml,/Beta/);
  assert.doesNotMatch(execHtml,/What people wrote/,'free text is admin and ops only');
  for(const role of ['admin','ops_manager']){
   const cookie=await login(role);
   const html=await freeze(FROZEN,()=>page('/pc?metric=enps',cookie));
   assert.match(html,/What people wrote/,role+' should see the comments');
   assert.match(html,/small centre 0/,'the comment text itself');
  }
 });

 await t.test('the round management page is admin/ops only and offers the export',async()=>{
  const adminCookie=await login('admin');
  const html=await freeze(FROZEN,()=>page('/admin/survey',adminCookie));
  assert.match(html,/eNPS trial — September 2026/);
  assert.match(html,/Download the mail-merge file/);
  // The Graph sender is offered as unavailable, with the reason, rather than hidden.
  assert.match(html,/Microsoft Graph is not configured/);
  assert.match(html,/GRAPH_TENANT_ID/);
  // The invitation draft is on the page.
  assert.match(html,/completely anonymous/);
  const viewerCookie=await login('viewer');
  const r=await freeze(FROZEN,()=>fetch(base+'/admin/survey',{headers:{cookie:viewerCookie},redirect:'manual'}));
  assert.equal(r.status,403,'a viewer must not manage rounds'); await r.text();
 });

 await t.test('the export downloads as a CSV and the addresses are only in the response',async()=>{
  const adminCookie=await login('admin');
  const r=await freeze(FROZEN,()=>fetch(base+'/admin/survey/'+round.id+'/export.csv',{headers:{cookie:adminCookie},redirect:'manual'}));
  assert.equal(r.status,200);
  assert.match(r.headers.get('content-type')||'',/text\/csv/);
  assert.match(r.headers.get('content-disposition')||'',/attachment; filename=/);
  const body=await r.text();
  const lines=body.trim().split('\r\n');
  assert.equal(lines[0],'email,centre,link');
  assert.equal(lines.length,ACTIVE_WITH_EMAIL+1,'one row per active staff member, plus the header');
  assert.match(body,/staff11@personal\.example/);
  assert.match(body,/https?:\/\/[^/]+\/s\/[A-Za-z0-9_-]{20,}/);
 });

 await t.test('the CSV neutralises anything Excel would run as a formula',()=>{
  const out=survey.csv([{email:'=cmd|calc!A1',centre:'Alpha',link:'https://x/s/t'},{email:'a"b@x.test',centre:'Be,ta',link:'https://x/s/u'}]);
  assert.match(out,/"'=cmd\|calc!A1"/,'a leading = must not survive as a formula');
  assert.match(out,/"a""b@x\.test"/,'a quote is doubled');
  assert.match(out,/"Be,ta"/,'a comma is quoted, not a new column');
 });

 // ===== Sending =====
 await t.test('with no Graph credentials the export is offered and the reason is said out loud',()=>{
  const a=surveyMail.graphAvailability({});
  assert.equal(a.available,false);
  assert.match(a.reason,/GRAPH_TENANT_ID/);
  assert.match(a.reason,/Mail\.Send/);
  assert.match(a.reason,/admin consent|admin's consent/);
  const s=surveyMail.senders({});
  assert.equal(s.find((x)=>x.key==='export').available,true,'the export must work with nothing configured');
  assert.equal(s.find((x)=>x.key==='graph').available,false);
  // All four present: available, and it says which mailbox it will send from.
  const ok=surveyMail.graphAvailability({GRAPH_TENANT_ID:'t',GRAPH_CLIENT_ID:'c',GRAPH_CLIENT_SECRET:'s',SURVEY_FROM_MAILBOX:'people@futuro.test'});
  assert.equal(ok.available,true);
  assert.match(ok.reason,/people@futuro\.test/);
  // One missing is still unavailable, and names the one that is missing.
  const partial=surveyMail.graphAvailability({GRAPH_TENANT_ID:'t',GRAPH_CLIENT_ID:'c',GRAPH_CLIENT_SECRET:'s'});
  assert.equal(partial.available,false);
  assert.match(partial.reason,/SURVEY_FROM_MAILBOX/);
  assert.doesNotMatch(partial.reason,/GRAPH_TENANT_ID/);
 });

 await t.test('the Graph message is shaped the way Graph expects, and keeps no copy',()=>{
  const b=surveyMail.sendMailBody({to:'a@b.test',subject:'S',body:'B'});
  assert.equal(b.message.toRecipients[0].emailAddress.address,'a@b.test');
  assert.equal(b.message.body.contentType,'Text');
  assert.equal(b.saveToSentItems,false,'221 copies carrying the recipient list is the one thing not to keep');
  assert.throws(()=>surveyMail.sendMailBody({to:'not-an-address',subject:'S',body:'B'}));
  assert.throws(()=>surveyMail.sendMailBody({to:'a@b.test',subject:'',body:'B'}));
 });

 await t.test('the invitation email says who it is from, that it is anonymous, how long, and when it closes',()=>{
  const m=survey.invitationEmail({centre:'Austral',link:'https://pulse.example/s/tok',closesOn:'2026-09-30',contact:'the Privacy Officer'});
  assert.match(m.subject,/Futuro Austral/);
  assert.match(m.subject,/anonymous/i);
  assert.match(m.body,/Futuro Austral/);
  assert.match(m.body,/https:\/\/pulse\.example\/s\/tok/);
  assert.match(m.body,/two minutes/i);
  assert.match(m.body,/30 September 2026/,'the closing date, written out');
  assert.match(m.body,/anonymous/i);
  assert.match(m.body,/don't name colleagues|don’t name colleagues/i);
  assert.match(m.body,/Futuro Early Learning/,'it has to say who it is from — most of these land in personal inboxes');
  assert.match(m.body,/the Privacy Officer/);
  // 217 of 221 addresses are personal, so it must not assume a Futuro sign-in or an intranet.
  assert.doesNotMatch(m.body,/sign in|log in to the|intranet/i);
 });

 await t.test('the magic link is public and survives the holding page, and Graph is documented',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  // The survey router must be mounted BEFORE requireLogin, or a respondent would be asked to sign in.
  const mount=server.indexOf('require("./routes/survey")'), guard=server.indexOf('app.use(requireLogin)');
  assert.ok(mount>0&&guard>0&&mount<guard,'routes/survey.js must be mounted before requireLogin');
  // And it must be let through MAINTENANCE: the invitation has already gone to personal inboxes with a
  // closing date on it, so the link cannot start showing an under-construction page.
  assert.match(server,/req\.path\.startsWith\("\/s\/"\)\s*\)\s*return next\(\);/);
  // The Graph variables have to be in render.yaml or nobody can switch the second sender on.
  const render=fs.readFileSync(path.join(__dirname,'..','render.yaml'),'utf8');
  for(const k of ['GRAPH_TENANT_ID','GRAPH_CLIENT_ID','GRAPH_CLIENT_SECRET','SURVEY_FROM_MAILBOX'])
   assert.match(render,new RegExp('key: '+k+'[^\\n]*\\n\\s+sync: false'),k+' must be documented as a secret in render.yaml');
  assert.match(render,/Mail\.Send/,'render.yaml must say which Graph permission to grant');
 });

 } finally {
  const { store }=require('../middleware/session');
  if(store&&store.stopPruning) store.stopPruning();
  await new Promise((r)=>server.close(r));
  db.close();
 }
});
