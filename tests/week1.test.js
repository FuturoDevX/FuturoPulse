// Week 1 feature tests: honest booked-ahead labels, seats & utilisation, projection trust note, Reg 12 tile.
// Harness mirrors tests/phase0.test.js: temp DB via DB_PATH, fixture users, app.listen(0). Later batches append t.test blocks.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pulse-week1-'));
process.env.DB_PATH=path.join(dir,'test.db');process.env.NODE_ENV='test';
process.env.ADMIN_EMAIL='test-admin@example.test';process.env.ADMIN_DEFAULT_PASSWORD='FixturePasswordOnly!';
process.env.SESSION_SECRET='fixture-session-only';process.env.ANTHROPIC_API_KEY='fixture';
const db=require('../db/db'), bcrypt=require('bcryptjs');
const pass='FixturePasswordOnly!';
for(const [id,name,cap,opening] of [['a','Centre Alpha',100,0],['b','Centre Beta',100,0],['open','Centre Opening',0,1]]) db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,?,?)').run(id,name,cap,opening);
for(const role of ['viewer','centre','exec','admin']) db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role+'@example.test',role,bcrypt.hashSync(pass,4),role,role==='centre'?'a':null);
// /admin/users can assign a centre login to a pre-opening centre, which has no utilisation row (opening=1, capacity=0).
db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run('centre-open@example.test','centre-open',bcrypt.hashSync(pass,4),'centre','open');
const m=require('../services/metrics'), cal=require('../services/calendar');
const today=m.todayStr();
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const monthShift=(n)=>{const [y,mo]=today.slice(0,7).split('-').map(Number);return new Date(Date.UTC(y,mo-1+n,1)).toISOString().slice(0,7);};
const dm=db.prepare('INSERT INTO daily_metrics(owna_id,metric_date,capacity,booked,attended,absent,casual,fee_total) VALUES(?,?,100,?,?,?,?,?)');
// King's Birthday week 2026: Mon 8 June is a NSW public holiday — OWNA still carries a booking row (nobody attends).
dm.run('a','2026-06-08',30,0,30,0,600); dm.run('a','2026-06-09',50,45,5,1,1000); dm.run('a','2026-06-10',70,60,10,2,1400);
dm.run('b','2026-06-09',40,40,0,0,800);
// Today (attendance known) and a week ahead (future rows carry OWNA's default "attending" flag).
dm.run('a',today,50,40,10,1,1000); dm.run('a',addDays(today,7),60,60,0,3,1200);
// Incidents: current month, three months back and eleven months back are inside the 12-month window; twelve back is not.
const inc=db.prepare('INSERT INTO incidents_monthly(owna_id,month,total,injuries,illness,serious,reportable) VALUES(?,?,?,?,?,?,?)');
inc.run('a',monthShift(0),10,8,2,0,1); inc.run('a',monthShift(-3),20,15,5,1,2); inc.run('a',monthShift(-11),12,10,2,0,1); inc.run('a',monthShift(-12),30,20,10,2,5);
// Batch 2 fixtures: one finalised pay week (ending Sun 14 Jun 2026, King's Birthday week). Alpha/Beta map to OWNA centres;
// HQ has no owna_id and the pre-opening centre has no bookings, so neither can have a per-child-day figure.
const lw=db.prepare('INSERT INTO labour_weekly(eh_centre,week_ending,owna_id,employees,worked_h,worked_amt,kitchen_h,kitchen_amt,cleaning_h,cleaning_amt,leave_h,leave_amt,matwc_amt,casual_h) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
lw.run('Futuro Alpha','2026-06-14','a',10,300,9000,20,600,10,240,20,600,0,30);
lw.run('Futuro Beta','2026-06-14','b',5,100,3000,10,400,0,0,5,200,0,0);
lw.run('Futuro HQ','2026-06-14',null,3,80,5000,0,0,0,0,0,0,0,0);
lw.run('Futuro Opening','2026-06-14','open',1,20,1000,0,0,0,0,0,0,0,0);
const INC_FIX=[[monthShift(0),10,8,2,0,1],[monthShift(-3),20,15,5,1,2],[monthShift(-11),12,10,2,0,1],[monthShift(-12),30,20,10,2,5]];
const incSum=(from,to)=>INC_FIX.filter(f=>f[0]>=from&&f[0]<=to).reduce((a,f)=>({total:a.total+f[1],injuries:a.injuries+f[2],illness:a.illness+f[3],serious:a.serious+f[4],reportable:a.reportable+f[5],months:a.months+1}),{total:0,injuries:0,illness:0,serious:0,reportable:0,months:0});
// Batch 4 fixtures: LineLeader link + pipeline members, tours and enrolment records. Names are fixtures — no page may print them.
for(const [ll,id] of [[1,'a'],[2,'b'],[3,'open']]) db.prepare('UPDATE centres SET ll_id=? WHERE owna_id=?').run(ll,id);
const llp=db.prepare('INSERT INTO ll_pipeline(snapshot_date,ll_id,centre_name,status_id,status_name,count) VALUES(?,?,?,?,?,?)');
llp.run(today,1,'Centre Alpha',4,'Waitlist',3);llp.run(today,1,'Centre Alpha',5,'Offer Accepted',1);llp.run(today,2,'Centre Beta',4,'Waitlist',1);
const mem=db.prepare('INSERT INTO ll_pipeline_members(child_id,ll_id,owna_id,centre_name,child_name,family_name,status_id,status_name,wait_list_date,expected_start) VALUES(?,?,?,?,?,?,?,?,?,?)');
// [child_id, ll_id, owna_id, status, wait_list_date, family]: Alpha joins this month (2), last month (2), six months back (3), 13 months back (1, outside the window), undated (1).
for(const [cid,ll,owna,st,wl,fam] of [[1,1,'a',1,today,'One'],[2,1,'a',4,today,'Two'],[3,1,'a',5,monthShift(-1)+'-10','Three'],[4,1,'a',11,monthShift(-1)+'-12','Four'],
  [5,1,'a',4,monthShift(-6)+'-03','Five'],[6,1,'a',12,monthShift(-6)+'-04','Six'],[7,1,'a',3,monthShift(-6)+'-05','Seven'],[8,1,'a',4,monthShift(-13)+'-15','Eight'],[9,1,'a',2,null,'Nine'],
  [10,2,'b',4,monthShift(-2)+'-01','Ten'],[11,2,'b',5,monthShift(-2)+'-02','Eleven'],[12,3,'open',1,today,'Twelve'],[13,null,null,2,today,'Thirteen']])
  mem.run(cid,ll,owna,owna?'Centre '+owna:null,'Fixture Child '+fam,'Fixture Family '+fam,st,String(st),wl,null);
// Alpha tours: completed last month; held (date passed) 3 months back; cancelled; scheduled next week; completed today; completed 13 months back; held by a non-member family.
const tour=db.prepare('INSERT INTO ll_tours(task_id,ll_id,owna_id,centre_name,family_name,type_name,tour_date,is_completed,is_cancelled) VALUES(?,?,?,?,?,?,?,?,?)');
for(const [id,fam,d,done,canc] of [[1,'Three',monthShift(-1)+'-15',1,0],[2,'Five',monthShift(-3)+'-10',0,0],[3,'Six',monthShift(-3)+'-11',0,1],[4,'Seven',addDays(today,5),0,0],[5,'One',today,1,0],[6,'Two',monthShift(-13)+'-20',1,0],[7,'Zed',monthShift(-2)+'-05',0,0]])
  tour.run(id,1,'a','Centre Alpha','Fixture Family '+fam,'Tour',d+'T00:30:00+00:00',done,canc);
// Enrolment records carry the EXPECTED start for every status: only Enrolled (Started, 6) with a past date is a real start.
const enr=db.prepare('INSERT INTO ll_enrolments(enrollment_id,ll_id,centre_name,child_id,status_id,start_date,withdrawn_date) VALUES(?,?,?,?,?,?,?)');
enr.run(1,1,'Centre Alpha',101,6,monthShift(-2)+'-01',null);enr.run(2,1,'Centre Alpha',102,6,monthShift(-1)+'-01',null);
enr.run(3,1,'Centre Alpha',5,4,monthShift(-1)+'-05',null); // waitlisted child whose expected start has passed — not a start
enr.run(4,1,'Centre Alpha',103,6,addDays(today,30),null); // enrolled, starts next month — not yet
enr.run(5,1,'Centre Alpha',104,6,monthShift(-13)+'-01',null); // outside the 12-month window
enr.run(6,2,'Centre Beta',105,9,monthShift(-2)+'-01',null); // Lost Opportunity — not a start
enr.run(7,1,'Centre Alpha',106,8,null,monthShift(-1)+'-01'); // withdrawn
const app=require('../server');
let server,base;
async function login(role){const r=await fetch(base+'/login',{method:'POST',body:new URLSearchParams({email:role+'@example.test',password:pass}),redirect:'manual'});assert.equal(r.status,302);return r.headers.get('set-cookie').split(';')[0];}
async function request(url,cookie){return fetch(base+url,{headers:{cookie},redirect:'manual'});}
async function page(url,cookie){const r=await request(url,cookie);assert.equal(r.status,200,url+' '+r.status);return r.text();}

test('Week 1 batch 1',async(t)=>{
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 try {
 await t.test('calendar counts NSW operating days',()=>{
  assert.equal(cal.operatingDays('2026-07-01','2027-06-30'),253); // FY2026-27: 261 weekdays − 8 weekday holidays
  assert.equal(cal.operatingDays('2026-01-01','2026-12-31'),253);
  assert.equal(cal.operatingDays('2026-06-08','2026-06-12'),4); // King's Birthday week
  assert.equal(cal.operatingDays('2026-09-12','2026-09-13'),0); // weekend
  assert.equal(cal.operatingDays('2026-09-11','2026-09-01'),0); // reversed range
  assert.equal(cal.isOperatingDay('2026-04-25'),false); // Anzac Day (Saturday)
  assert.equal(cal.isOperatingDay('2026-04-24'),true);
  assert.equal(cal.isOperatingDay('2026-10-05'),false); // Labour Day
  assert.deepEqual(cal.unknownHolidayYears('2024-06-01','2025-01-01'),[2024]);
  assert.deepEqual(cal.operatingDayList('2026-04-02','2026-04-07'),['2026-04-02','2026-04-07']); // Easter 2026
 });
 await t.test('yearStart / yearRange follow the 1 July financial year by default',()=>{
  assert.equal(m.yearStart('fy','2026-09-11'),'2026-07-01');
  assert.equal(m.yearStart('fy','2026-03-01'),'2025-07-01');
  assert.equal(m.yearStart('cy','2026-09-11'),'2026-01-01');
  assert.deepEqual(m.yearRange('fy','2026-09-11'),{kind:'fy',start:'2026-07-01',end:'2027-06-30',label:'FY2026-27',ytdLabel:'FYTD'});
  assert.deepEqual(m.yearRange('cy','2026-09-11'),{kind:'cy',start:'2026-01-01',end:'2026-12-31',label:'CY2026',ytdLabel:'CYTD'});
  assert.equal(m.yearRange('bogus','2026-09-11').kind,'fy');
 });
 await t.test('seatsFilled averages booked children over operating days only',()=>{
  const s=m.seatsFilled('2026-06-08','2026-06-12');
  assert.equal(s.operating_days,4);
  assert.deepEqual(s.rows.map(r=>[r.owna_id,r.booked,r.days,r.seats]),[['a',120,2,60],['b',40,1,40]]); // holiday row excluded
  assert.deepEqual(s.group,{booked:160,days:2,seats:80});
  assert.equal(s.byOwna.a.seats,60);
  assert.deepEqual(m.seatsFilled('2026-06-13','2026-06-14').group,{booked:0,days:0,seats:0});
 });
 await t.test('utilisationYtd divides operating-day bookings by places × operating days, with the annual denominator',()=>{
  const u=m.utilisationYtd('fy','2026-06-12');
  assert.equal(u.label,'FY2025-26');assert.equal(u.start,'2025-07-01');assert.equal(u.end,'2026-06-30');assert.equal(u.today,'2026-06-12');
  const opYtd=cal.operatingDays('2025-07-01','2026-06-12');
  assert.equal(u.operating_days_ytd,opYtd);assert.equal(u.operating_days_year,253);
  assert.equal(u.places,200); // pre-opening centre excluded
  assert.deepEqual(u.rows.map(r=>[r.owna_id,r.booked,r.cap_days,r.utilisation]),[['a',120,100*opYtd,m.pct(120,100*opYtd)],['b',40,100*opYtd,m.pct(40,100*opYtd)]]);
  assert.deepEqual(u.group,{booked:160,cap_days:200*opYtd,utilisation:m.pct(160,200*opYtd),capacity:200,annual_child_days:200*253});
  assert.equal(u.annual_child_days,50600);
  const c=m.utilisationYtd('cy','2026-06-12');assert.equal(c.label,'CY2026');assert.equal(c.start,'2026-01-01');assert.equal(c.operating_days_year,253);
 });
 await t.test('overview splits past and booked-ahead days; attendance is past days only',()=>{
  const row=m.overview(today,addDays(today,7)).find(r=>r.owna_id==='a');
  assert.equal(row.days,2);assert.equal(row.past_days,1);assert.equal(row.future_days,1);
  assert.equal(row.booked,110);assert.equal(row.past_booked,50);assert.equal(row.future_booked,60);
  assert.equal(row.attended,40);assert.equal(row.absent,10);assert.equal(row.attendance_rate,80);
  assert.equal(row.fee_total,2200);assert.equal(row.fee_past,1000);assert.equal(row.fee_future,1200);
  const t1=m.totals(m.overview(today,addDays(today,7)));
  assert.equal(t1.attendance_rate,80);assert.equal(t1.fee_future,1200);assert.equal(t1.past_days,1);assert.equal(t1.future_days,1);
  const t0=m.totals(m.overview(today,today));
  assert.equal(t0.attendance_rate,80);assert.equal(t0.fee_future,0);assert.equal(t0.future_days,0);assert.equal(t0.booked,50);
  assert.equal(m.totals([]).attendance_rate,0);
 });
 await t.test('reg12Last12Months sums reportable incidents over the 12 months to now',()=>{
  const r=m.reg12Last12Months('a');
  assert.equal(r.reportable,4);assert.equal(r.months,3);assert.equal(r.from_month,monthShift(-11));assert.equal(r.to_month,monthShift(0));
  assert.equal(r.first_month,monthShift(-11));assert.equal(r.last_month,monthShift(0));
  assert.deepEqual(m.reg12Last12Months('b'),{from_month:monthShift(-11),to_month:monthShift(0),reportable:0,serious:0,total:0,months:0,first_month:null,last_month:null});
  assert.equal(m.reg12Last12Months('a','2026-09-11').from_month,'2025-10');
 });
 await t.test('overview labels booked-ahead ranges honestly and shows seats and utilisation',async()=>{
  const c=await login('admin');
  const ahead=await page(`/?from=${today}&to=${addDays(today,7)}`,c);
  assert.match(ahead,/booked ahead — departures not yet deducted, so this overstates/);
  assert.match(ahead,/past days only/);
  assert.match(ahead,/Fees: billed to date \+ booked ahead/);
  assert.match(ahead,/\$1,000 billed to date · \$1,200 booked ahead/);
  assert.match(ahead,/Fees billed to date \+ booked ahead/); // table header
  assert.match(ahead,/Seats filled, avg per day/);
  assert.match(ahead,/Utilisation FYTD · FY/);
  assert.match(ahead,/Annual denominator FY\d{4}-\d{2} = \d+ operating days/);
  const past=await page(`/?from=${addDays(today,-6)}&to=${today}`,c);
  assert.doesNotMatch(past,/booked ahead/);
  assert.doesNotMatch(past,/past days only/);
  assert.match(past,/Fees billed/);
  assert.match(past,/Seats filled, avg per day/);
  const cy=await page(`/?from=${addDays(today,-6)}&to=${today}&year=cy`,c);
  assert.match(cy,/Utilisation CYTD · CY\d{4}/);
  assert.match(cy,/Showing calendar year/);
  // Seats over King's Birthday week: Alpha 60, Beta 40, group 80 (holiday booking row ignored).
  const kb=await page('/?from=2026-06-08&to=2026-06-12',c);
  assert.match(kb,/2 operating days with bookings/);
  assert.match(kb,/<td class="num">60<\/td>/);assert.match(kb,/<td class="num">40<\/td>/);assert.match(kb,/<td class="num">80<\/td>/);
  // Viewer (aggregates only) and centre-scoped logins render the same tiles for their scope.
  assert.match(await page('/',await login('viewer')),/Seats filled, avg per day/);
  const scoped=await page(`/?from=${today}&to=${addDays(today,7)}`,await login('centre'));
  assert.match(scoped,/booked ahead — departures not yet deducted/);assert.doesNotMatch(scoped,/Centre Beta/);
  // The utilisation footnote is per centre: a scoped login sees its own 100 places, never the 200-place group denominator.
  const gu=m.utilisationYtd('fy',today);
  assert.match(scoped,/÷ \(100 places ×/);assert.doesNotMatch(scoped,new RegExp('\\('+gu.places+' places ×'));
  // A scoped login on a centre with no utilisation row (pre-opening, 0 licensed places) must get no figures at all, not the group's.
  const noCap=await page('/',await login('centre-open'));
  assert.match(noCap,/No licensed places recorded for your centre yet, so utilisation cannot be calculated\./);
  assert.doesNotMatch(noCap,/Utilisation FYTD \(FY/);assert.doesNotMatch(noCap,/Annual denominator/);
  assert.doesNotMatch(noCap,new RegExp(gu.places+' places'));
  assert.doesNotMatch(noCap,new RegExp(gu.group.cap_days.toLocaleString('en-AU')+' child-days'));
  assert.doesNotMatch(noCap,new RegExp(gu.annual_child_days.toLocaleString('en-AU')+' child-days'));
  assert.match(await page('/?year=cy',await login('centre-open')),/Showing calendar year/); // the year toggle hint survives the suppression
 });
 await t.test('projection is renamed, sits after the pipeline in the nav and carries the 90-day trust note',async()=>{
  const c=await login('exec');
  const html=await page('/projection',c);
  const iPipe=html.indexOf('>Enrolment Pipeline<'), iProj=html.indexOf('>Enrolment Projection<'), iExit=html.indexOf('>Exit Report<');
  assert.ok(iPipe>0&&iProj>iPipe&&iExit>iProj,'nav order pipeline → projection → exits');
  assert.doesNotMatch(html,/>Projection</);
  assert.match(html,/Trust the first 90 days\.<\/strong> Beyond that the line adds pipeline starts but never deducts departures, so it is a ceiling, not a forecast\./);
  assert.match(html,/next 90 days/);
  assert.match(html,/6 mo · ceiling/);
  assert.doesNotMatch(html,/Projected with pipeline \(ceiling\)/);
  const long=await page('/projection?days=180',c);
  assert.match(long,/next 180 days/);assert.match(long,/Projected with pipeline \(ceiling\)/);assert.match(long,/badge warn">ceiling/);
  assert.match(await page('/projection?days=999',c),/next 90 days/); // default stays 90
 });
 await t.test('Q&C shows the Reg 12 tile for the selected centre and links to Safety',async()=>{
  const c=await login('admin');
  const a=await page('/qc?owna=a',c);
  assert.match(a,/Serious incidents \(Reg 12\), last 12 months/);
  assert.match(a,/Emergency services attended or medical attention sought — the two Reg 12 tests\. Recorded from OWNA incident reports\./);
  assert.match(a,/reg12-stat"><div class="n">4<\/div>/);
  assert.match(a,/3 months of data/);
  assert.match(a,/href="\/safety"/);
  const b=await page('/qc?owna=b',c);
  assert.match(b,/reg12-stat"><div class="n">—<\/div>/);assert.match(b,/No incident data for this centre yet/);
  assert.match(await page('/qc',await login('centre')),/3 months of data/); // scoped to Alpha
  assert.equal((await request('/qc',await login('viewer'))).status,403);
 });
 // ===== Batch 2 (Day 2): safety totals + YTD + year choice, Department notifications, wages per child-day =====
 await t.test('incidentsReport carries year-to-date, last-12-month and window totals for the chosen reporting year',()=>{
  const fy=m.incidentsReport(null,12,null,'fy');
  const fyStart=m.yearStart('fy',today).slice(0,7);
  assert.equal(fy.year.kind,'fy');assert.equal(fy.ytd.kind,'fy');assert.equal(fy.ytd.start,m.yearStart('fy',today));
  assert.match(fy.ytd.ytdLabel,/^FY \d{4}-\d{2} to date$/);
  assert.equal(fy.ytd.from_month,fyStart);assert.equal(fy.ytd.to_month,monthShift(0));
  const eFy=incSum(fyStart,monthShift(0));
  assert.deepEqual(fy.ytd.group,eFy);
  assert.deepEqual(fy.ytd.rows,[{owna_id:'a',name:'Centre Alpha',...eFy}]);
  assert.deepEqual(fy.rows[0].ytd,fy.ytd.rows[0]);
  // Last 12 calendar months: the three fixture months inside the window, not the one twelve months back.
  assert.equal(fy.last12.from_month,monthShift(-11));assert.equal(fy.last12.to_month,monthShift(0));
  assert.deepEqual(fy.last12.group,{total:42,injuries:33,illness:9,serious:1,reportable:4,months:3});
  assert.deepEqual(fy.rows[0].last12,{owna_id:'a',name:'Centre Alpha',total:42,injuries:33,illness:9,serious:1,reportable:4,months:3});
  // Window totals = every displayed month (only four distinct months exist, so all four are shown).
  assert.deepEqual(fy.rows[0].window,{months:4,total:72,injuries:53,illness:19,serious:3,reportable:9});
  assert.deepEqual(fy.windowTotals,{months:4,total:72,injuries:53,illness:19,serious:3,reportable:9});
  // Calendar year.
  const cy=m.incidentsReport(null,12,null,'cy');
  const cyStart=m.yearStart('cy',today).slice(0,7);
  assert.equal(cy.ytd.kind,'cy');assert.equal(cy.ytd.from_month,cyStart);
  assert.match(cy.ytd.ytdLabel,/^\d{4} to date$/);assert.equal(cy.ytd.ytdLabel,cyStart.slice(0,4)+' to date');
  assert.deepEqual(cy.ytd.group,incSum(cyStart,monthShift(0)));
  // Explicit "today": FY2026-27 to date on 11 Sep 2026 runs Jul → Sep 2026; unknown year kinds fall back to FY.
  const fixed=m.incidentsReport(null,12,null,'fy','2026-09-11');
  assert.equal(fixed.ytd.ytdLabel,'FY 2026-27 to date');assert.equal(fixed.ytd.from_month,'2026-07');assert.equal(fixed.ytd.to_month,'2026-09');
  assert.equal(fixed.last12.from_month,'2025-10');
  assert.equal(m.incidentsReport(null,12,null,'cy','2026-09-11').ytd.ytdLabel,'2026 to date');
  assert.equal(m.incidentsReport(null,12,null,'bogus').ytd.kind,'fy');
  // Scoped to a centre without incidents: no rows, zero group.
  const none=m.incidentsReport('b',12,null,'fy');
  assert.deepEqual(none.rows,[]);assert.deepEqual(none.ytd.group,{total:0,injuries:0,illness:0,serious:0,reportable:0,months:0});
  // Existing shape is unchanged.
  assert.equal(fy.rows[0].name,'Centre Alpha');assert.equal(fy.headline.total,fy.totals.find(x=>x.month===fy.selectedMonth).total);
 });
 await t.test('Safety page shows Total columns, the YTD block in the warn colour, the FY / Calendar toggle and Department notifications',async()=>{
  const c=await login('admin');
  const html=await page('/safety',c);
  const eFy=incSum(m.yearStart('fy',today).slice(0,7),monthShift(0));
  assert.match(html,/FY \d{4}-\d{2} to date/);
  assert.match(html,new RegExp('<div class="n warn-text">'+eFy.total+'</div><div class="l">Total incident reports · FY \\d{4}-\\d{2} to date'));
  assert.match(html,new RegExp('class="ytd-total">'+eFy.total+'</td>'));
  assert.match(html,/<th style="text-align:right;">Total<\/th><th style="text-align:right;">Injuries<\/th>/); // monthly and YTD tables
  assert.match(html,/Total<br><span style="font-weight:400;text-transform:none;">4 mo<\/span>/); // trend grid total column
  assert.match(html,/border-left:2px solid var\(--line,#e5e7eb\);font-weight:700;">72<br>/);
  assert.match(html,/Notified to the Department · FY \d{4}-\d{2} to date/);
  assert.match(html,new RegExp('<div class="n">4</div><div class="l">Notified to the Department · last 12 months'));
  assert.match(html,/emergency services attended or medical attention sought, from OWNA incident reports/);
  assert.match(html,/OWNA does not expose a separate “notified” flag/);
  assert.match(html,/href="\/safety\?year=fy" class="on"/);assert.match(html,/href="\/safety\?year=cy" class=""/);
  assert.match(html,/>FY<\/a> \| <a href="\/safety\?year=cy"[^>]*>Calendar<\/a>/);
  assert.match(html,/<input type="hidden" name="year" value="fy">/);
  assert.doesNotMatch(html,/ to date · Jul \d{4} → Jul/); // sanity: label is the reporting year, not a month
  const cy=await page('/safety?year=cy',c);
  const eCy=incSum(m.yearStart('cy',today).slice(0,7),monthShift(0));
  assert.match(cy,new RegExp('<div class="n warn-text">'+eCy.total+'</div><div class="l">Total incident reports · \\d{4} to date'));
  assert.doesNotMatch(cy,/FY \d{4}-\d{2} to date/);
  assert.match(cy,/href="\/safety\?year=cy" class="on"/);assert.match(cy,/<input type="hidden" name="year" value="cy">/);
  // A chosen month survives the toggle links; the default month does not pin itself.
  const rep=m.incidentsReport(null,12,null,'fy');
  const other=rep.months.find(mm=>mm!==rep.lastComplete);
  assert.match(await page('/safety?month='+other,c),new RegExp('href="/safety\\?year=cy&amp;month='+other+'"'));
  assert.match(html,/href="\/safety\?year=cy"/);
  // Viewer (aggregates only) and centre-scoped users still open the page; no child, family or staff names are present.
  const v=await page('/safety',await login('viewer'));assert.match(v,/Notified to the Department/);assert.doesNotMatch(v,/child_name|family_name/);
  assert.match(await page('/safety?year=cy',await login('centre')),/\d{4} to date/);
 });
 await t.test('ownaWeek returns booked child-days on operating days and labourForWeek prices wages per child-day',()=>{
  // King's Birthday week: Alpha has booking rows Mon 8 (holiday, 30), Tue 9 (50), Wed 10 (70); Beta Tue 9 (40).
  assert.deepEqual(m.ownaWeek('a','2026-06-14'),{revenue:3000,occupancy:50,child_days:120,op_days:2});
  assert.deepEqual(m.ownaWeek('b','2026-06-14'),{revenue:800,occupancy:40,child_days:40,op_days:1});
  assert.deepEqual(m.ownaWeek(null,'2026-06-14'),{revenue:0,occupancy:null,child_days:0,op_days:0});
  assert.deepEqual(m.ownaWeek('open','2026-06-14'),{revenue:0,occupancy:null,child_days:0,op_days:0});
  assert.deepEqual(m.labourWeeks(16),['2026-06-14']);
  const rows=m.labourForWeek('2026-06-14');
  const by=Object.fromEntries(rows.map(r=>[r.eh_centre,r]));
  assert.equal(by['Futuro Alpha'].child_days,120);assert.equal(by['Futuro Alpha'].care_wages,9600);
  assert.equal(by['Futuro Alpha'].wages_per_child_day,80); // 9600 / 120
  assert.equal(by['Futuro Alpha'].all_in_per_child_day,87); // (9600 + 600 + 240) / 120
  assert.equal(by['Futuro Beta'].wages_per_child_day,80); // 3200 / 40
  assert.equal(by['Futuro Beta'].all_in_per_child_day,90); // (3200 + 400) / 40
  assert.equal(by['Futuro HQ'].child_days,0);assert.equal(by['Futuro HQ'].wages_per_child_day,null);assert.equal(by['Futuro HQ'].all_in_per_child_day,null);
  assert.equal(by['Futuro Opening'].wages_per_child_day,null);
  assert.deepEqual(m.wagesPerChildDay(rows),{centres:2,child_days:160,care_wages:12800,all_wages:14040,per_child_day:80,all_in_per_child_day:88});
  assert.deepEqual(m.wagesPerChildDay([]),{centres:0,child_days:0,care_wages:0,all_wages:0,per_child_day:null,all_in_per_child_day:null});
  // Existing fields are untouched.
  assert.equal(by['Futuro Alpha'].revenue,3000);assert.equal(by['Futuro Alpha'].wage_pct,320);assert.equal(by['Futuro HQ'].worked_amt,5000);
 });
 await t.test('Wages page shows per child-day columns, the total row, the group tile and the footnote',async()=>{
  const c=await login('admin');
  const html=await page('/wages?week=2026-06-14',c);
  assert.match(html,/<th class="num">Educator wages<br>per child-day<\/th>\s*<th class="num">All-in<br>per child-day<\/th>/);
  assert.match(html,/<td class="num">\$80<\/td>\s*<td class="num">\$87<\/td>/); // Alpha
  assert.match(html,/<td class="num">\$80<\/td>\s*<td class="num">\$90<\/td>/); // Beta
  assert.match(html,/<td class="num"><span class="muted">—<\/span><\/td>\s*<td class="num"><span class="muted">—<\/span><\/td>/); // HQ / pre-opening
  assert.match(html,/<td class="num">\$80<\/td>\s*<td class="num">\$88<\/td>\s*<td class="num">—<\/td>/); // total row
  assert.match(html,/<div class="n">\$80<\/div><div class="l">Wages per child-day<span class="cap">educator wages ÷ 160 booked child-days · all-in \$88<\/span>/);
  assert.match(html,/<strong>Wages per child-day<\/strong> = educator wages \(worked \+ leave \+ other\) ÷ booked child-days/);
  assert.doesNotMatch(html,/\$80\.\d/);
  assert.equal((await request('/wages',await login('centre'))).status,403); // still blocked for centre logins
 });
 // ===== Batch 3 (Day 3): exits by month / year, finish dates set, tenure, churn by centre and room =====
 await t.test('exitsByMonth, exitsByYear and upcomingExitsByMonth count OWNA finish dates per centre and group',()=>{
  // Fixtures (inserted here so batches 1–2 above are unaffected): a third operating centre with an enrolled headcount
  // but no booking rows, and departures / scheduled finishes anchored to the current month. Names must never render.
  db.prepare("INSERT INTO centres(owna_id,name,capacity,enrolled,opening) VALUES('c','Centre Gamma',80,50,0)").run();
  // Batch 6: child_exits is de-identified — no child_name, no dob — so the fixtures carry an opaque key only.
  const ex=db.prepare("INSERT INTO child_exits(owna_id,child_key,room,start_date,finish_date,tenure_days,upcoming,reason,reason_source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))");
  const mk=(id,key,room,finish,tenure,up,reason)=>ex.run(id,key,room,null,finish,tenure,up,reason||null,reason?'lineleader':null);
  mk('a','a1','Room 6',monthShift(0)+'-01',730,0,'Aged Out-Too Old'); mk('a','a2','Room 6',monthShift(-1)+'-15',365,0,'Another Centre');
  mk('a','a3','Room 1',monthShift(-3)+'-10',0,0); mk('a','a4','Room 3',monthShift(-6)+'-20',null,0); // zero / missing tenure → excluded from tenure
  mk('a','a5','Room 2',monthShift(-13)+'-05',100,0); // outside the 12-month churn window, inside the 24-month table
  mk('b','b1','Toddlers',monthShift(0)+'-01',200,0); mk('b','b2',null,monthShift(-10)+'-12',800,0); // no room recorded
  mk('c','c1','Nursery',monthShift(-2)+'-03',50,0);
  mk('a','a6','Room 6',monthShift(1)+'-15',null,1); mk('a','a7','Room 6',monthShift(3)+'-15',null,1); mk('b','b3','Toddlers',monthShift(9)+'-01',null,1);
  const bm=m.exitsByMonth(24);
  assert.equal(bm.months.length,24);assert.equal(bm.months[0],monthShift(-23));assert.equal(bm.current,monthShift(0));
  assert.equal(bm.captured_from,monthShift(-13)+'-05');
  assert.deepEqual(bm.rows.map(r=>[r.owna_id,r.total]),[['a',5],['b',2],['c',1]]);
  const idx=(n)=>23+n, a=bm.rows[0], b=bm.rows[1];
  assert.equal(a.points[idx(-14)],null);assert.equal(bm.group.points[idx(-23)],null); // before the snapshot look-back: not captured
  assert.equal(a.points[idx(-13)],1);assert.equal(a.points[idx(-12)],0);assert.equal(a.points[idx(-6)],1);assert.equal(a.points[idx(-3)],1);assert.equal(a.points[idx(-1)],1);assert.equal(a.points[idx(0)],1);
  assert.equal(b.points[idx(-10)],1);assert.equal(b.points[idx(0)],1);assert.equal(bm.group.points[idx(0)],2);assert.equal(bm.group.total,8);
  assert.equal(m.exitsByMonth(3).months.length,3);
  // Years: FY (default) and calendar, labelled, with the current year "to date" and a partially captured first year.
  const fyKey=(d)=>{const y=+d.slice(0,4);return String(+d.slice(5,7)>=7?y:y-1);};
  const fy=m.exitsByYear('fy');
  assert.equal(fy.kind,'fy');assert.equal(fy.years[0].key,fyKey(monthShift(-13)+'-05'));assert.equal(fy.years[fy.years.length-1].key,fyKey(today));
  const cur=fy.years[fy.years.length-1];assert.equal(cur.label,'FY '+cur.key+'-'+String(+cur.key+1).slice(2));assert.equal(cur.to_date,true);assert.equal(cur.start,cur.key+'-07-01');
  assert.equal(fy.years[0].captured_from,monthShift(-13)+'-05');
  const fixA=[monthShift(0)+'-01',monthShift(-1)+'-15',monthShift(-3)+'-10',monthShift(-6)+'-20',monthShift(-13)+'-05'];
  fy.years.forEach(y=>assert.equal(fy.rows[0].counts[y.key],fixA.filter(d=>fyKey(d)===y.key).length,'FY '+y.key));
  assert.equal(fy.rows[0].total,5);assert.equal(fy.group.total,8);assert.equal(fy.years.reduce((s,y)=>s+fy.group.counts[y.key],0),8);
  const cy=m.exitsByYear('cy');
  assert.equal(cy.kind,'cy');assert.equal(cy.years[cy.years.length-1].label,today.slice(0,4));assert.equal(cy.years[cy.years.length-1].to_date,today.slice(5)!=='12-31');
  cy.years.forEach(y=>assert.equal(cy.rows[0].counts[y.key],fixA.filter(d=>d.slice(0,4)===y.key).length,'CY '+y.key));
  assert.equal(m.exitsByYear('bogus').kind,'fy');
  assert.deepEqual(m.exitsByYear('fy','2026-09-11').years.map(y=>y.label).slice(-1),['FY 2026-27']);
  // Finish dates already set: current month + 7, anything later in `later`.
  const up=m.upcomingExitsByMonth(8);
  assert.deepEqual(up.months,[0,1,2,3,4,5,6,7].map(monthShift));
  assert.deepEqual(up.rows.map(r=>[r.owna_id,r.points,r.later,r.total]),[['a',[0,1,0,1,0,0,0,0],0,2],['b',[0,0,0,0,0,0,0,0],1,1],['c',[0,0,0,0,0,0,0,0],0,0]]);
  assert.deepEqual(up.group,{points:[0,1,0,1,0,0,0,0],later:1,total:3});
 });
 await t.test('tenureByCentre averages departed children with a positive tenure, in years, with a JS median',()=>{
  const tn=m.tenureByCentre();
  assert.deepEqual(tn.rows.map(r=>[r.owna_id,r.departed,r.n,r.excluded,r.avg_years,r.median_years,r.avg_days,r.median_days]),[
   ['a',5,3,2,1.09,1.00,398,365],  // 730, 365, 100 days
   ['b',2,2,0,1.37,1.37,500,500],
   ['c',1,1,0,0.14,0.14,50,50]]);
  assert.deepEqual(tn.group,{departed:8,excluded:2,n:6,avg_days:374,median_days:283,avg_years:1.02,median_years:0.77}); // median of 6 = (200+365)/2
  assert.ok(tn.rows.every(r=>!('child_name' in r)));
 });
 await t.test('churnByRoom annualises departures over average booked per operating day, rooms in descending order',()=>{
  const ch=m.churnByRoom(12);
  assert.equal(ch.to,today);assert.equal(ch.months,12);
  const f=new Date(today+'T00:00:00Z');f.setUTCMonth(f.getUTCMonth()-12);assert.equal(ch.from,f.toISOString().slice(0,10));
  const a=ch.rows[0], b=ch.rows[1], c=ch.rows[2];
  // Alpha: 4 departures in the window (the 13-month-old one drops out). Booking rows: 9 Jun (50), 10 Jun (70) and today's
  // (50) when today is an operating day; the King's Birthday row and the booked-ahead row are excluded.
  const op=cal.isOperatingDay(today), sum=120+(op?50:0), days=2+(op?1:0);
  assert.equal(a.departures,4);assert.equal(a.annualised,4);assert.equal(a.denominator_source,'booked');
  assert.equal(a.booked_days,days);assert.equal(a.avg_booked,Math.round(sum/days*10)/10);
  assert.equal(a.churn_pct,Math.round(4/(sum/days)*1000)/10);
  assert.deepEqual(a.rooms,[{room:'Room 6',n:2,share:50},{room:'Room 1',n:1,share:25},{room:'Room 3',n:1,share:25}]);
  assert.deepEqual([b.departures,b.avg_booked,b.booked_days,b.churn_pct,b.denominator_source,b.enrolled],[2,40,1,5,'booked',0]);
  assert.deepEqual(b.rooms,[{room:'Toddlers',n:1,share:50},{room:'Not recorded',n:1,share:50}]); // unnamed room sorts last
  assert.deepEqual([c.departures,c.avg_booked,c.booked_days,c.enrolled,c.denominator_source,c.churn_pct],[1,null,0,50,'enrolled',2]); // 1 ÷ 50 headcount
  assert.equal(ch.group.departures,7);assert.equal(ch.group.avg_booked,Math.round((sum/days+40+50)*10)/10);
  assert.equal(ch.group.churn_pct,Math.round(7/(sum/days+40+50)*1000)/10);
  const f6=new Date(today+'T00:00:00Z');f6.setUTCMonth(f6.getUTCMonth()-6);const from6=f6.toISOString().slice(0,10);
  const n6=[monthShift(0)+'-01',monthShift(-1)+'-15',monthShift(-3)+'-10',monthShift(-6)+'-20'].filter(d=>d>from6&&d<=today).length;
  const six=m.churnByRoom(6);assert.equal(six.rows[0].departures,n6);assert.equal(six.rows[0].annualised,n6*2); // 6-month window annualised × 2
 });
 await t.test('Exit Report shows month / year tables, the COE leaver table, tenure, churn and no names; year toggle works',async()=>{
  const c=await login('admin');
  const html=await page('/exits',c);
  assert.match(html,/Departures by month <span[^>]*>· last 24 months/);
  assert.match(html,/Departures by financial year/);assert.match(html,/FY \d{4}-\d{2} <span class="muted">\(to date\)<\/span>/);
  assert.match(html,/href="\/exits\?year=fy" class="on"/);assert.match(html,/href="\/exits\?year=cy" class=""/);
  assert.match(html,/Finish dates already set <span[^>]*>· next 8 months · the COE leaver signal/);
  assert.match(html,/This is the COE leaver signal/);
  assert.match(html,/<div class="n">1\.02 yrs<\/div><div class="l">Average tenure of departed children<span class="cap">median 0\.77 yrs · based on 6 of 8 departed children/);
  assert.match(html,/Average tenure of departed children <span[^>]*>· years from OWNA start date/);
  assert.match(html,/<td class="num">3<span class="muted"> \(2 without\)<\/span><\/td><td class="num">1\.09<\/td><td class="num">1\.00<\/td>/); // Alpha tenure row
  assert.match(html,/Churn by centre <span[^>]*>· last 12 months/);
  assert.match(html,/vs enrolled headcount/); // Gamma has no booking data
  assert.match(html,/<td>Room 6<\/td><td class="num">2<\/td><td class="num">50%<\/td>/);
  assert.match(html,/<td>Not recorded<\/td><td class="num">1<\/td>/);
  assert.match(html,/room at exit as recorded in OWNA/);
  assert.match(html,/365-day look-back, EXIT_LOOKBACK_DAYS/);assert.match(html,/<td class="num">—<\/td>/); // not-captured months
  assert.match(html,/ \(so far\)<\/td>/);
  assert.doesNotMatch(html,/Fixture Child/);
  const cy=await page('/exits?year=cy',c);
  assert.match(cy,/Departures by calendar year/);assert.match(cy,/href="\/exits\?year=cy" class="on"/);
  assert.match(cy,new RegExp('<th class="num">'+today.slice(0,4)+' <span class="muted">\\(to date\\)'));
  assert.doesNotMatch(cy,/Departures by financial year/);
  assert.match(await page('/exits',await login('exec')),/COE leaver signal/);
  assert.equal((await request('/exits',await login('viewer'))).status,403); // aggregates-only login stays out
  assert.equal((await request('/exits',await login('centre'))).status,403); // centre-scoped login stays out
 });
 // ---- Batch 4: funnel conversions, cohort filter, lead & tour targets, unused places / utilisation ----
 await t.test('funnelByCentre: snapshot stage shares, 12-month conversion strip, cohort filter, no names',()=>{
  const f=m.funnelByCentre();
  assert.equal(f.mode,'window');assert.equal(f.to,today);
  const fr=new Date(today+'T00:00:00Z');fr.setUTCMonth(fr.getUTCMonth()-12);assert.equal(f.from,fr.toISOString().slice(0,10));
  assert.deepEqual(f.stages.map(s=>s[0]),[1,2,11,3,12,5]);
  assert.deepEqual(f.rows.map(r=>[r.owna_id,r.opening,r.total]),[['a',false,9],['b',false,2],['open',true,1]]); // LineLeader-linked centres, operating first
  const a=f.rows[0];
  assert.deepEqual(a.stages.map(s=>[s.id,s.count,s.share]),[[1,1,11.1],[2,1,11.1],[11,1,11.1],[3,1,11.1],[12,1,11.1],[5,1,11.1]]);
  assert.deepEqual(a.waitlist,{id:4,name:'Waitlist',count:3,share:33.3});
  // leads 7 joined + 2 started; tours: completed last month, held 3 months back, completed today, non-member held (cancelled, future and 13-month-old excluded)
  assert.deepEqual(a.strip,{leads:9,leads_joined:7,tours_held:4,tours_completed:2,offers:3,offers_current:1,started:2,tour_pct:44.4,offer_pct:33.3,start_pct:22.2});
  assert.deepEqual(f.rows[1].strip,{leads:2,leads_joined:2,tours_held:0,tours_completed:0,offers:1,offers_current:1,started:0,tour_pct:0,offer_pct:50,start_pct:0}); // Lost Opportunity is not a start
  assert.deepEqual(f.rows[2].stages.map(s=>s.count),[1,0,0,0,0,0]);assert.equal(f.rows[2].strip.leads,1);
  assert.equal(f.group.total,12);assert.deepEqual(f.group.waitlist,{id:4,name:'Waitlist',count:4,share:33.3});
  assert.deepEqual(f.group.stages.map(s=>s.count),[2,1,1,1,1,2]);
  assert.deepEqual(f.group.strip,{leads:12,leads_joined:10,tours_held:4,tours_completed:2,offers:4,offers_current:2,started:2,tour_pct:33.3,offer_pct:33.3,start_pct:16.7});
  assert.ok(JSON.stringify(f).indexOf('Fixture')<0);
  const c=m.funnelByCentre(monthShift(-6));
  assert.equal(c.mode,'cohort');assert.equal(c.month,monthShift(-6));
  assert.deepEqual(c.rows[0].stages.map(s=>[s.id,s.count,s.share]),[[1,0,0],[2,0,0],[11,0,0],[3,1,33.3],[12,1,33.3],[5,0,0]]);
  assert.equal(c.rows[0].waitlist.count,1);assert.equal(c.rows[0].total,3);
  assert.deepEqual(c.rows[0].strip,{leads:3,leads_joined:3,tours_held:1,tours_completed:0,offers:0,offers_current:0,started:null,tour_pct:33.3,offer_pct:0,start_pct:null}); // the cohort's cancelled + future tours excluded
  assert.deepEqual(c.rows.slice(1).map(r=>r.total),[0,0]);assert.equal(c.group.strip.started,null);assert.equal(c.group.strip.leads,3);assert.equal(c.group.strip.tours_held,1);
  const n=m.funnelByCentre(monthShift(0));
  assert.deepEqual(n.rows.map(r=>[r.owna_id,r.total,r.strip.leads,r.strip.tours_held,r.strip.tours_completed]),[['a',2,2,1,1],['b',0,0,0,0],['open',1,1,0,0]]);
  assert.equal(m.funnelByCentre('nonsense').mode,'window');
  assert.deepEqual(m.funnelMonths(),[monthShift(0),monthShift(-1),monthShift(-2),monthShift(-6),monthShift(-13)]); // latest first, months with joiners only
 });
 await t.test('pipeline targets: admin/ops form saves standing monthly targets; pipeline page shows month-to-date deltas',async()=>{
  assert.equal(m.targetRag(10,10,0.5),'good');assert.equal(m.targetRag(5,10,0.5),'warn');assert.equal(m.targetRag(4,10,0.5),'bad');assert.equal(m.targetRag(0,null,0.5),null);assert.equal(m.targetRag(0,0,0.5),null);
  const pr0=m.pipelineTargetProgress();
  assert.equal(pr0.month,today.slice(0,7));assert.equal(pr0.has_targets,false);
  assert.deepEqual(pr0.rows.map(r=>[r.owna_id,r.leads,r.tours_held,r.tours_completed,r.leads_target,r.leads_rag,r.tours_delta]),[['a',2,1,1,null,null,null],['b',0,0,0,null,null,null],['open',1,0,0,null,null,null]]);
  const admin=await login('admin'), exec=await login('exec'), viewer=await login('viewer'), centre=await login('centre');
  let html=await page('/pipeline',admin);
  assert.match(html,/This month vs targets <span[^>]*>· \w+ \d{4} · day \d+ of \d+/);
  assert.match(html,/href="\/admin\/pipeline-targets">Set targets<\/a>/);assert.match(html,/<td class="num">—<\/td>/);
  assert.match(html,/href="\/admin\/pipeline-targets"[^>]*>Pipeline targets<\/a>/); // admin nav
  assert.doesNotMatch(await page('/pipeline',exec),/Pipeline targets<\/a>/);
  for(const c of [exec,viewer,centre]) assert.equal((await request('/admin/pipeline-targets',c)).status,403);
  const post=(cookie,body)=>fetch(base+'/admin/pipeline-targets',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),redirect:'manual'});
  assert.equal((await post(exec,{leads_a:'99'})).status,403);assert.deepEqual(m.pipelineTargets(),{});
  html=await page('/admin/pipeline-targets',admin);
  assert.match(html,/name="leads_a"/);assert.match(html,/name="tours_open"/);assert.match(html,/Centre Opening <span class="muted">\(opening\)<\/span>/);
  let r=await post(admin,{leads_a:'10',tours_a:'4',leads_b:'',tours_b:'',leads_open:'2',tours_open:''});
  assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/admin/pipeline-targets?saved=1');
  assert.deepEqual(Object.entries(m.pipelineTargets()).map(([k,v])=>[k,v.month,v.leads,v.tours]).sort(),[['a','default',10,4],['open','default',2,null]]);
  m.savePipelineTarget('b','2099-01',{leads:7,tours:null});assert.equal(m.pipelineTargets('2099-01').b.leads,7);assert.equal(m.pipelineTargets().b,undefined); // month override only for that month
  const pr=m.pipelineTargetProgress();
  const [yy,mm]=pr.month.split('-').map(Number);const dim=new Date(Date.UTC(yy,mm,0)).getUTCDate();const el=Number(today.slice(8,10))/dim;
  assert.equal(pr.days_in_month,dim);assert.equal(pr.day,Number(today.slice(8,10)));assert.equal(pr.has_targets,true);
  const a=pr.rows[0];
  assert.deepEqual([a.leads,a.leads_target,a.leads_delta,a.leads_rag,a.tours_held,a.tours_target,a.tours_delta,a.tours_rag],[2,10,-8,m.targetRag(2,10,el),1,4,-3,m.targetRag(1,4,el)]);
  assert.ok(['warn','bad'].includes(a.leads_rag));
  assert.deepEqual([pr.rows[1].leads_target,pr.rows[1].leads_rag],[null,null]);
  assert.deepEqual([pr.rows[2].leads_delta,pr.rows[2].leads_rag,pr.rows[2].tours_target,pr.rows[2].tours_rag],[-1,m.targetRag(1,2,el),null,null]);
  html=await page('/pipeline',admin);
  assert.match(html,new RegExp('<span class="badge '+a.leads_rag+'">-8</span>'));assert.match(html,new RegExp('<span class="badge '+a.tours_rag+'">-3</span>'));
  assert.match(html,new RegExp('<td>Centre Alpha</td>\\s*<td class="num">2</td>\\s*<td class="num">10</td>\\s*<td class="num"><span class="badge '+a.leads_rag+'">-8</span></td>\\s*<td class="num">1</td>\\s*<td class="num">4</td>'));
  assert.match(html,/<td>Centre Beta<\/td>\s*<td class="num">0<\/td>\s*<td class="num">—<\/td>\s*<td class="num">—<\/td>/); // no target → dashes
  html=await page('/admin/pipeline-targets?saved=1',admin);assert.match(html,/Targets saved\./);assert.match(html,/name="leads_a" value="10"/);assert.match(html,/name="tours_open" value=""/);
  r=await post(admin,{leads_a:'',tours_a:'',leads_open:'2',tours_open:'abc'});assert.equal(r.status,302);
  assert.deepEqual(Object.entries(m.pipelineTargets()).map(([k,v])=>[k,v.leads,v.tours]),[['open',2,null]]); // both blank removes Alpha's target; non-numeric = blank
  db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run('ops_manager@example.test','ops',bcrypt.hashSync(pass,4),'ops_manager');
  const ops=await login('ops_manager');assert.equal((await request('/admin/pipeline-targets',ops)).status,200);assert.match(await page('/pipeline',ops),/Set targets/);
 });
 await t.test('Enrolment Pipeline shows the funnel snapshot, 12-month strip and cohort filter — counts only, never names',async()=>{
  const admin=await login('admin');
  let html=await page('/pipeline',admin);
  assert.match(html,/Funnel conversions by centre <span[^>]*>· all pipeline families/);
  assert.match(html,/Stage counts are a snapshot<\/strong>/);assert.match(html,/the conversion strip is activity<\/strong> over the 12 months to /);
  assert.match(html,/<td>Centre Alpha<\/td>\s*<td class="num">1 <span class="muted">11\.1%<\/span><\/td>(\s*<td class="num">1 <span class="muted">11\.1%<\/span><\/td>){5}\s*<td class="num hot">3 <span class="muted">33\.3%<\/span><\/td>\s*<td class="num">9<\/td>/);
  assert.match(html,/<td>Centre Alpha<\/td>\s*<td class="num">9 <span class="muted"[^>]*>7 \+ 2<\/span><\/td>\s*<td class="num">4 <span class="muted">44\.4% · 2 marked complete<\/span><\/td>\s*<td class="num">3 <span class="muted">33\.3%<\/span><\/td>\s*<td class="num">2 <span class="muted">22\.2%<\/span><\/td>/);
  assert.match(html,/<td>All centres<\/td>\s*<td class="num">12 <span class="muted"[^>]*>10 \+ 2<\/span><\/td>/);
  assert.match(html,/<td>Centre Opening <span class="muted">\(opening\)<\/span><\/td>/);
  assert.match(html,new RegExp('<option value="'+monthShift(-6)+'" >Joined '));assert.match(html,/<option value="" selected>All leads<\/option>/);
  assert.doesNotMatch(html,/Fixture/);
  const co=await page('/pipeline?month='+monthShift(-6),admin);
  assert.match(co,/families who joined the wait list in /);assert.match(co,new RegExp('<option value="'+monthShift(-6)+'" selected>'));
  assert.match(co,/<td>Centre Alpha<\/td>\s*<td class="num">3<\/td>\s*<td class="num">1 <span class="muted">33\.3% · 0 marked complete<\/span><\/td>\s*<td class="num">0 <span class="muted">0%<\/span><\/td>\s*<td class="num">—<\/td>/);
  assert.match(co,/cannot be shown for a cohort/);assert.match(co,new RegExp('<input type="hidden" name="month" value="'+monthShift(-6)+'">')); // centre selector keeps the cohort
  assert.doesNotMatch(co,/Fixture/);
  assert.match(await page('/pipeline?month=2099-13',admin),/all pipeline families/); // unknown month → all leads
  const v=await page('/pipeline',await login('viewer'));assert.doesNotMatch(v,/Fixture/);assert.doesNotMatch(v,/Set targets/);assert.match(v,/Funnel conversions by centre/);
  assert.doesNotMatch(await page('/pipeline',await login('exec')),/Set targets/);
  assert.equal((await request('/pipeline',await login('centre'))).status,403);
 });
 await t.test('compare: unused places & utilisation per operating day, gaps for months without data, lower-is-better ranking',async()=>{
  assert.deepEqual(m.placesByMonth('a',100,'2026-06','2026-06'),[{month:'2026-06',booked:120,operating_days:21,places:100,avg_booked:5.7,unused_places:94.3,utilisation:5.7}]); // King's Birthday row excluded
  assert.deepEqual(m.placesByMonth('b',100,'2026-01','2026-05'),[]);
  assert.equal(m.COMPARE_METRICS.unused_places.better,'low');assert.equal(m.COMPARE_METRICS.utilisation.better,'high');assert.equal(m.COMPARE_METRICS.utilisation.suf,'%');
  const u=m.compareTrend('unused_places');
  assert.equal(u.cadence,'month');assert.equal(u.axis.length,15);assert.equal(u.axis[12],today.slice(0,7));assert.equal(u.dashFrom,11);
  assert.deepEqual(u.series.map(s=>s.name),['Centre Alpha','Centre Beta','Centre Gamma']); // every operating centre incl. Gamma (added by the exits batch); pre-opening centre excluded
  const ji=u.axis.indexOf('2026-06');
  if(ji>=0){
   assert.equal(u.series[0].points[ji],94.3);assert.equal(u.series[1].points[ji],98.1);
   const withData=new Set(['2026-06',today.slice(0,7),addDays(today,7).slice(0,7)]);
   u.axis.forEach((mo,i)=>{if(!withData.has(mo))assert.equal(u.series[0].points[i],null,mo);if(mo!=='2026-06')assert.equal(u.series[1].points[i],null,mo);}); // gaps, not zeros
   assert.deepEqual(u.series[2].points,u.axis.map(()=>null)); // Gamma has places but no booking rows at all — every month a gap, never 0 unused places
   if(ji<=u.dashFrom){
    assert.deepEqual(u.ranking.map(r=>[r.name,r.latest,r.tone]),[['Centre Alpha',94.3,'good'],['Centre Beta',98.1,'bad']]); // lower is better
    const ut=m.compareTrend('utilisation');assert.equal(ut.series[0].points[ji],5.7);
    assert.deepEqual(ut.ranking.map(r=>[r.name,r.latest,r.tone]),[['Centre Alpha',5.7,'good'],['Centre Beta',1.9,'bad']]); // higher is better
   }
  }
  const occ=m.compareTrend('occupancy');assert.equal(occ.dashFrom,11);assert.equal(occ.axis.length,15);assert.ok(Array.isArray(occ.ranking));
  const wk=m.compareTrend('wage_pct');assert.equal(wk.cadence,'week');assert.ok(Array.isArray(wk.ranking));
  const admin=await login('admin');
  const html=await page('/compare?metric=unused_places',admin);
  assert.match(html,/Unused places, avg per day/);assert.match(html,/<strong>Unused places<\/strong> = licensed places/);assert.match(html,/left as gaps, not zero/);
  if(ji>=0&&ji<=u.dashFrom){assert.match(html,/<td class="num good-text" style="font-weight:600;">94\.3 places<\/td>/);assert.match(html,/<td class="num bad-text" style="font-weight:600;">98\.1 places<\/td>/);}
  assert.match(await page('/compare?metric=utilisation',admin),/best in green, worst in red/);
  assert.doesNotMatch(await page('/compare?metric=occupancy',admin),/<strong>Unused places<\/strong>/);
  assert.equal((await request('/compare?metric=unused_places',await login('centre'))).status,403);
  assert.equal((await request('/compare?metric=unused_places',await login('viewer'))).status,200);
 });
 // ===== Batch 5 (Day 5): Continuation of Enrolment — the 2027 campaign outlook, Nov 2026 – Apr 2027 =====
 await t.test('coeOutlook builds the Nov 2026 – Apr 2027 outlook from run rate, leavers and firm backfill',()=>{
  // Fixtures are inserted here, last, so no earlier batch is affected. The window is fixed (it is the 2027
  // campaign), but the run-rate week follows today, so booking rows go into whichever Mon–Fri week is picked.
  db.prepare("UPDATE centres SET enrolled=40 WHERE owna_id='a'").run();          // avg booked days per child = 100 ÷ 40 = 2.5
  db.prepare("UPDATE centres SET opening_year=2026,opening_month=11 WHERE owna_id='open'").run();
  db.prepare("INSERT INTO centres(owna_id,name,capacity,enrolled,opening,opening_year,opening_month) VALUES('far','Centre Far',0,0,1,2028,1)").run();
  const rw=m.coeRunWeek();
  assert.equal(new Date(rw.to+'T00:00:00Z').getUTCDay(),5);assert.equal(new Date(rw.from+'T00:00:00Z').getUTCDay(),1);assert.ok(rw.to<today);
  for(let i=0;i<5;i++) dm.run('a',addDays(rw.from,i),20,20,0,0,400);              // 5 × 20 = 100 booked child-days in the run week
  const ex5=db.prepare("INSERT INTO child_exits(owna_id,child_key,room,start_date,finish_date,tenure_days,upcoming,reason,reason_source,updated_at) VALUES(?,?,'Room 2',NULL,?,NULL,1,NULL,NULL,datetime('now'))");
  ex5.run('a','a8','2026-11-20');                                                 // finishes 20 Nov: 10 of November's 30 days lost
  ex5.run('b','b4','2026-11-10');                                                 // Beta has no enrolled headcount → no day estimate
  const st=db.prepare("INSERT INTO ll_pipeline_starts(enrollment_id,ll_id,owna_id,centre_name,child_name,status_id,expected_start,days_csv,updated_at) VALUES(?,1,?,?,?,?,?,?,datetime('now'))");
  const mkStart=(id,owna,status,start,days)=>st.run(id,owna,'Centre '+owna,'Fixture Child S'+id,status,start,days);
  mkStart(901,'a',5,'2026-11-01','mo,tu,we');        // firm, whole of November: 3 days/wk
  mkStart(902,'a',12,'2026-11-16','mo,tu,we,th,fr'); // firm, from 16 Nov: 5 days/wk × 15 of 30 days
  mkStart(903,'a',4,'2026-11-01','mo,tu');           // waitlist — all-pipeline only, never in the projection
  mkStart(904,'a',5,'2026-12-05','');                // firm but no requested days recorded → no child-days claimed
  mkStart(905,'a',5,'2027-05-03','mo,tu,we,th,fr');  // starts after the window → out of scope
  mkStart(906,'b',12,'2027-02-10','th,fr');          // Beta's only committed days, from 10 Feb
  mkStart(907,'open',5,'2026-11-02','mo,tu,we,th,fr');
  mkStart(908,'open',4,'2026-12-01','mo,tu');
  const o=m.coeOutlook();
  assert.deepEqual(o.months.map(x=>x.month),['2026-11','2026-12','2027-01','2027-02','2027-03','2027-04']);
  assert.deepEqual(o.months.map(x=>x.operating_days),[21,21,19,20,21,22]); // NSW calendar: Christmas/Boxing Day, New Year + Australia Day, Easter
  assert.deepEqual(o.months.map(x=>x.operating_days),o.months.map(x=>cal.operatingDays(x.month+'-01',x.month+'-'+x.days_in_month)));
  assert.deepEqual(o.window,{first:'2026-11',last:'2027-04'});assert.equal(o.as_at,today);assert.deepEqual(o.run_week,rw);
  assert.equal(o.pipeline_from,today.slice(0,7)+'-01');assert.equal(o.target_pct,95);assert.deepEqual(o.unknown_holiday_years,[]);
  assert.deepEqual(o.centres.map(c=>c.owna_id),['a','b','c']); // operating centres with licensed places; the pre-opening ones are not here
  const a=o.centres[0];
  assert.equal(a.places,100);assert.equal(a.enrolled,40);assert.equal(a.run_week_days,100);assert.equal(a.avg_days_per_child,2.5);
  const nov=a.months[0];
  assert.equal(nov.available_days,2100);                       // 100 places × 21 operating days
  assert.equal(nov.run_rate_days,420);                         // 100 booked × 21/5
  assert.equal(nov.leavers_in_month,1);assert.equal(nov.leavers_to_date,2); // a6 (already gone by November) + a8
  assert.equal(nov.leaver_days,14);                            // 2.5 × 21/5 × (1 + 10/30)
  assert.equal(nov.firm_children,2);assert.equal(nov.firm_days,23.1);       // 3 × 4.2 + 5 × 4.2 × 15/30
  assert.equal(nov.all_children,3);assert.equal(nov.all_days,31.5);         // + the waitlist family's 2 days/wk
  assert.equal(nov.projected_days,429.1);assert.equal(nov.pct,20.4);assert.equal(nov.gap_days,1565.9); // 2100 × 95% − 429.1
  const dec=a.months[1];
  assert.equal(dec.leavers_to_date,3);assert.equal(dec.leavers_in_month,1);  // a7 finishes 15 Dec
  assert.equal(dec.leaver_days,26.4);                          // 10.5 + 10.5 + 10.5 × 16/31
  assert.equal(dec.firm_children,2);assert.equal(dec.firm_days,33.6);        // both now count for the whole month; the blank days_csv start adds nothing
  assert.equal(dec.projected_days,427.2);
  assert.deepEqual(a.months.map(x=>x.leavers_to_date),[2,3,3,3,3,3]);        // leavers stay deducted from every later month
  const b=o.centres[1];
  assert.equal(b.run_week_days,0);assert.equal(b.avg_days_per_child,0);
  assert.deepEqual(b.months.map(x=>x.leaver_days),[0,0,0,0,0,0]);            // a leaver with no enrolled headcount to average over removes no estimated days
  assert.equal(b.months[0].leavers_to_date,1);
  assert.equal(b.months[3].firm_days,5.4);assert.equal(b.months[3].projected_days,5.4);assert.equal(b.months[3].pct,0.3); // 2 × 20/5 × 19/28
  assert.equal(b.months[2].firm_days,0);                                     // February's start is not counted in January
  assert.deepEqual(o.centres[2].months.map(x=>x.pct),[0,0,0,0,0,0]);         // Gamma has places but no bookings and no pipeline
  assert.equal(o.group.places,280);assert.equal(o.group.run_week_days,100);
  const gn=o.group.months[0];
  assert.equal(gn.available_days,100*21+100*21+80*21);assert.equal(gn.run_rate_days,420);
  assert.equal(gn.leavers_to_date,3);assert.equal(gn.leaver_days,14);assert.equal(gn.firm_days,23.1);
  assert.equal(gn.projected_days,429.1);assert.equal(gn.pct,m.pct(429.1,5880));
  // Pre-opening centres: the one opening inside the window, with firm vs all-pipeline days and the requested weekday mix.
  assert.deepEqual(o.opening.map(c=>c.owna_id),['open']);                     // Centre Far (2028) is beyond the window
  const op=o.opening[0];
  assert.equal(op.places,0);assert.equal(op.opening_year,2026);assert.equal(op.opening_month,11);
  assert.deepEqual(op.mix,{mo:2,tu:2,we:1,th:1,fr:1});assert.equal(op.mix_families,2);
  assert.equal(op.months[0].firm_days,20.3);assert.equal(op.months[0].all_days,20.3);assert.equal(op.months[0].firm_children,1); // 5 × 4.2 × 29/30
  assert.equal(op.months[1].firm_days,21);assert.equal(op.months[1].all_days,29.4);assert.equal(op.months[1].all_children,2);
  assert.deepEqual(m.coeMonthKeys('2026-11',3),['2026-11','2026-12','2027-01']);
 });
 await t.test('the Continuation of Enrolment page states its three limits, is open to viewers and never names a family',async()=>{
  const admin=await login('admin');
  const html=await page('/coe',admin);
  assert.match(html,/First release — continuing count and booking mix follow/);
  assert.match(html,/The run rate assumes every family without a finish date continues, so it is a ceiling\.<\/strong>/);
  assert.match(html,/January reads high because leavers are still present until late January while starters are added from their start dates\.<\/strong>/);
  assert.match(html,/Leaver days are estimated from each centre's average booking pattern, not each leaver's own days\.<\/strong>/);
  assert.match(html,/Nov 2026 – Apr 2027/);
  assert.match(html,/Feb 2027, the anchor month/);
  assert.match(html,/target 95% is a placeholder/);
  assert.match(html,/<strong>placeholder<\/strong> only/);
  assert.match(html,/% once licensed places are confirmed/);                    // opening centres get no percentage
  assert.match(html,/title="429 of 2,100 days">20\.4%<\/td>/);                  // Alpha, November: 429 of 2,100 available child-days
  assert.match(html,/<td class="num">5,880<\/td>/);                             // group available child-days in November (280 places × 21 days)
  assert.match(html,/Centre Far/);                                              // only in the sidebar's "Opening soon" list
  assert.doesNotMatch(html.split('<main>')[1],/Centre Far/);                     // not in the outlook itself
  assert.doesNotMatch(html,/Fixture Child/);assert.doesNotMatch(html,/Fixture Family/);
  const viewer=await page('/coe',await login('viewer'));
  assert.match(viewer,/Continuation of Enrolment/);assert.doesNotMatch(viewer,/Fixture/);
  assert.match(viewer,/href="\/coe"/);                                          // nav link, in the Enrolment group
  assert.match(viewer,/href="\/pipeline"[^>]*>Enrolment Pipeline<\/a>\s*<a href="\/coe"[^>]*>Continuation of Enrolment<\/a>\s*<a href="\/projection"/);
  assert.equal((await request('/coe',await login('exec'))).status,200);
  assert.equal((await request('/coe',await login('centre'))).status,403);        // blockScoped: centre-scoped users stay on their own centre
 });
 // ===== Batch 6 (privacy, APP 11.2): departures are stored de-identified; history survives in exits_monthly =====
 await t.test('runExitReport stores no child name or DOB, still matches LineLeader reasons, and keeps a departure that falls out of the look-back',async()=>{
  const snapshot=require('../services/snapshot');
  const {owna}=require('../services/owna'), {lineleader}=require('../services/lineleader');
  const realChildren=owna.listChildren, realCreds=lineleader.hasCreds, realWithdrawn=lineleader.enrolmentsWithdrawn;
  // Its own centre, plus a fake OWNA that reports nobody for the others: the rebuild is a full per-centre
  // replace, so it clears the batch 3 exit fixtures. Nothing after this test reads them.
  db.prepare("INSERT INTO centres(owna_id,name,capacity,enrolled,opening) VALUES('px','Centre Privacy',60,40,0)").run();
  const DOB='2021-04-05', day=(n)=>addDays(today,n);
  const kids=[
   {firstname:'Old',      surname:'Leaver',dob:DOB,room:'Room 1',activeFrom:day(-900), finishDate:day(-500)},  // inside an 800-day look-back, outside 365
   {firstname:'Recent',   surname:'Leaver',dob:DOB,room:'Room 2',activeFrom:day(-385), finishDate:day(-20)},
   {firstname:'Scheduled',surname:'Leaver',dob:DOB,room:'Room 2',activeFrom:day(-100), finishDate:day(40)},    // finish date already set
   {firstname:'Ancient',  surname:'Leaver',dob:DOB,room:'Room 1',activeFrom:day(-1500),finishDate:day(-1200)}, // outside both look-backs
   {firstname:'Staying',  surname:'Leaver',dob:DOB,room:'Room 2',activeFrom:day(-100), finishDate:null},       // not an exit at all
  ];
  owna.listChildren=async(id)=>(id==='px'?kids:[]);
  lineleader.hasCreds=()=>true;
  // LineLeader knows why the recent one left. The match is on name + date of birth, in memory, during the run.
  lineleader.enrolmentsWithdrawn=async()=>[{child:{values:{name:'Recent Leaver',birthdate:DOB}},withdrawn:{reason:{values:{value:'Another Centre'}}}}];
  try {
   process.env.EXIT_LOOKBACK_DAYS='800';
   const r1=await snapshot.runExitReport({log(){}});
   assert.deepEqual([r1.total,r1.matched,r1.failed],[3,1,0]);
   // (a) The name and DOB columns are gone from the table, not merely left empty.
   const cols=db.prepare("PRAGMA table_info(child_exits)").all().map(c=>c.name);
   assert.ok(!cols.includes('child_name')&&!cols.includes('dob'),'child_exits still has '+cols.join(','));
   const rows=db.prepare("SELECT * FROM child_exits WHERE owna_id='px' ORDER BY finish_date").all();
   assert.equal(rows.length,3);
   const stored=JSON.stringify(rows);
   for(const s of ['Old','Recent','Scheduled','Ancient','Staying','Leaver',DOB]) assert.ok(stored.indexOf(s)<0,'a stored exit row leaks "'+s+'"');
   // child_key is an opaque salted hash: no name, and guessing the name cannot reproduce it.
   assert.ok(rows.every(r=>/^[0-9a-f]{32}$/.test(r.child_key)));
   const guess=require('crypto').createHash('sha256').update('recentleaver|'+DOB).digest('hex').slice(0,32);
   assert.ok(rows.every(r=>r.child_key!==guess));
   // (a) Matching still works: the departure LineLeader has a withdrawal for carries its reason.
   const recent=rows.find(r=>r.finish_date===day(-20)), old=rows.find(r=>r.finish_date===day(-500)), sched=rows.find(r=>r.upcoming===1);
   assert.deepEqual([recent.reason,recent.reason_source,recent.tenure_days,recent.room],['Another Centre','lineleader',365,'Room 2']);
   assert.deepEqual([old.reason,old.reason_source,old.tenure_days],[null,null,400]);
   assert.equal(sched.finish_date,day(40));
   assert.ok(m.centreExits('px','past',10).every(r=>!('child_name' in r)&&!('dob' in r)));
   // (b) The rebuild folded itself into the monthly aggregate.
   assert.deepEqual(db.prepare("SELECT month,room,upcoming,departures,tenure_days_sum,tenure_n FROM exits_monthly WHERE owna_id='px' ORDER BY month").all(),[
    {month:day(-500).slice(0,7),room:'Room 1',upcoming:0,departures:1,tenure_days_sum:400,tenure_n:1},
    {month:day(-20).slice(0,7), room:'Room 2',upcoming:0,departures:1,tenure_days_sum:365,tenure_n:1},
    {month:day(40).slice(0,7),  room:'Room 2',upcoming:1,departures:1,tenure_days_sum:140,tenure_n:1}]);
   // (b) Slide the look-back back to its real 365 days: the old departure leaves the detail, the count stays.
   process.env.EXIT_LOOKBACK_DAYS='365';
   const r2=await snapshot.runExitReport({log(){}});
   assert.equal(r2.total,2);
   assert.deepEqual(db.prepare("SELECT finish_date FROM child_exits WHERE owna_id='px' ORDER BY finish_date").all().map(r=>r.finish_date),[day(-20),day(40)]);
   const oldMonth=day(-500).slice(0,7);
   assert.deepEqual(db.prepare("SELECT departures,tenure_days_sum,tenure_n FROM exits_monthly WHERE owna_id='px' AND month=? AND upcoming=0").get(oldMonth),
    {departures:1,tenure_days_sum:400,tenure_n:1});
   assert.equal(db.prepare("SELECT COUNT(*) n FROM child_exits WHERE finish_date < ?").get(day(-400)).n,0); // nothing that old is in the detail
   // exitsByMonth and exitsByYear read that month from the aggregate; the detail window starts much later.
   const by=m.exitsByMonth(24), px=by.rows.find(r=>r.owna_id==='px');
   assert.equal(px.points[by.months.indexOf(oldMonth)],1);
   assert.equal(px.points[by.months.indexOf(day(-20).slice(0,7))],1);
   assert.equal(by.history_from,oldMonth+'-01');
   assert.equal(by.captured_from,day(-20));
   const cy=m.exitsByYear('cy');
   assert.equal(cy.years[0].key,day(-500).slice(0,4));
   assert.equal(cy.rows.find(r=>r.owna_id==='px').counts[day(-500).slice(0,4)],1);
   assert.equal(cy.captured_from,oldMonth+'-01');
   // (c) Nothing renders a name, and the footnote says where detail ends and the aggregate takes over.
   const admin=await login('admin');
   const html=await page('/exits',admin);
   assert.doesNotMatch(html,/Leaver|Fixture Child/);
   assert.match(html,/<strong>Detail covers the last 12 months; years build up from the monthly aggregate\.<\/strong>/);
   assert.match(html,/no child’s name or date of birth is stored by this dashboard/);
   assert.match(html,/Years are counted from the monthly aggregate, which outlives the 12-month detail window/);
   const centre=await page('/centre/px',admin);
   assert.doesNotMatch(centre,/Leaver|Fixture Child/);
   assert.doesNotMatch(centre,/Child \(name hidden\)/);
   assert.match(centre,/<thead><tr><th>Room<\/th><th>Started<\/th><th>Left<\/th>/); // the Child column is gone
  } finally {
   owna.listChildren=realChildren;lineleader.hasCreds=realCreds;lineleader.enrolmentsWithdrawn=realWithdrawn;
   delete process.env.EXIT_LOOKBACK_DAYS;
  }
 });
 } finally {await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
