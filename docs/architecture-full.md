# 풀 엔터프라이즈 ERP — 전체 도메인 지도 & 균형 개발 계획
## 40인 제조·수출입 B2B / SAP 전체 모듈 모방 + 4PL 물류 심화

> 스택 확정: TypeScript 모노레포(Next.js 16 + NestJS 11 + PostgreSQL 16 + Drizzle + Redis/BullMQ + Turborepo/pnpm).
> 이 문서는 repo에 `docs/architecture-full.md`로 커밋해서 CLAUDE.md가 참조하게 쓰는 용도.

---

## 1. 전체 도메인 지도 (17개 도메인 + 횡단기능 / SAP 모듈 매핑)

NestJS 모노레포에서 `apps/api/src/domains/<도메인>/<모듈>` 구조. 모든 거래 모듈은 최종적으로 **FI(회계) 더블엔트리 분개**로 흘러들어간다 — 이게 핵심 설계 원칙.

### ① platform (플랫폼/기반)
auth · rbac(CASL 권한) · org-structure(회사·공장·저장위치·영업조직·구매조직 = SAP 엔터프라이즈 구조) · numbering(문서번호 채번 = SAP Number Range) · workflow(전자결재) · notification · file-storage · audit-log · i18n(ko/en) · **admin-config**(시스템 설정/코드·문서유형·파라미터 관리 = SAP IMG, 4대보험 요율 등 config 테이블 UI) · **data-migration**(초기 데이터 이관 + 엑셀 업/다운로드, go-live 기초잔액 적재) · **output-forms**(인보이스·PO·급여명세·B/L PDF 생성·이메일 발송 양식 엔진) · job-monitor(BullMQ 배치 모니터링)

### ② master-data (마스터 데이터)
material(품목+HS코드+무역속성) · business-partner(고객/공급사/포워더/선사/은행/관세사 = SAP BP) · bom · gl-account(계정과목) · cost-center / profit-center · bank-master · currency / fx-rate · uom · tax-code(부가세) · pricing-condition(가격조건)

### ③ finance-accounting (회계 = SAP FI)
general-ledger(총계정원장, 분개) · accounts-receivable(AR) · accounts-payable(AP) · fixed-assets(고정자산/감가상각) · tax(부가세신고·전자세금계산서 홈택스 연계) · bank-reconciliation · period-close(월/연 마감) · financial-statements(재무제표 BS/IS/CF)

### ④ controlling (관리회계 = SAP CO)
cost-center-accounting · profit-center-accounting · internal-order · product-costing(제품원가) · profitability-analysis(CO-PA: 제품×지역×고객×채널 수익성)

### ⑤ treasury (재무 = SAP TRM, 회계와 별개)
cash-management(일별 자금수지) · liquidity-planning(유동성 계획) · bank-communication(펌뱅킹/오픈뱅킹, 입출금 자동인식) · fx-risk(환위험·선물환·헤지) · borrowing(차입금) · payment-run(지급실행/자동이체)

### ⑥ procurement (구매 = SAP MM-구매 + SRM)
purchase-requisition(PR) · purchase-order(PO, 국내+수입) · vendor-management(공급사 평가/소싱) · rfq(견적요청) · contract(구매계약) · goods-receipt(GR 입고) · invoice-verification(IV, 3-way match)

### ⑦ inventory-warehouse (재고/창고 = SAP MM-IM + WM/EWM)
inventory(이동평균/FIFO, 재고이동) · warehouse(창고·Bin·입출고) · goods-movement(입고/출고/이동/조정) · batch-serial(로트/시리얼) · stock-taking(재고실사)

### ⑧ sales (영업 = SAP SD)
inquiry-quotation(문의/견적) · sales-order(수주, 국내+수출) · delivery(출하) · billing(청구/매출세금계산서) · pricing(가격결정) · credit-management(여신) · returns(반품)

### ⑨ crm (고객관계관리 = SAP Sales Cloud/C4C, 영업과 별개)
account-contact(고객/연락처) · lead(리드) · opportunity(영업기회/파이프라인) · activity(전화/미팅/메일) · campaign(마케팅) · crm-quotation(→SD 연계) · service-ticket(클레임/AS) · forecast(매출예측)

### ⑩ manufacturing-quality (생산/품질 = SAP PP + QM)
bom-management(다단 BOM) · routing(공정/작업장) · mrp(자재소요계획) · production-order(작업지시) · capacity-planning(능력소요) · confirmation(실적/backflush) · subcontracting(외주가공) · quality(입고·공정·출하검사, 검사로트, 불량관리)

### ⑪ logistics-4pl (물류/포워딩 = 심화 핵심)
shipment-booking(선적부킹 S/R) · freight-forwarding(MBL/HBL, FCL/LCL, 콘솔) · transportation(운송관리 TM: carrier·구간·운임 tariff·운송비 정산) · customs-brokerage(관세사 신고대행 워크플로) · 3pl-warehouse(화주별 재고분리, 보관/하역 과금) · control-tower(멀티 carrier/3PL 관제·가시성) · cargo-tracking(컨테이너/마일스톤 이벤트, UNI-PASS 화물진행) · logistics-billing(운임+관세+수수료 청구, 예정원가 vs 실제원가 accrual, cost-plus/profit-share) · logistics-document(B/L·AWB·Manifest·Arrival Notice·D/O)

### ⑫ trade-compliance (무역/컴플라이언스 = SAP GTS)
letter-of-credit(L/C MT700) · customs-declaration(수출입신고, UNI-PASS) · fta-origin(원산지 PSR·C/O·FTA-PASS) · hs-classification(HS 분류) · duty-drawback(**관세환급** — 수출용 수입원재료 관세 개별/간이정액 환급, 수입제조수출사 필수 현금항목) · trade-document(Commercial Invoice/Packing List/Proforma) · incoterms · compliance-screening(SPL/전략물자/제재) · cargo-insurance(적하보험)

### ⑬ hr-payroll (인사/급여 = SAP HCM, 한국 특화)
org-management(조직/직급/직무) · personnel(인사기본·발령·입퇴사) · time(근태·연차, 근로기준법) · payroll(급여계산: 4대보험·소득세·수당) · year-end-tax(연말정산) · severance(퇴직금/퇴직연금 DB·DC) · recruiting(채용) · appraisal(인사평가) · expense(경비정산)

### ⑭ integration (대외연계 = EDI/인터페이스, 무역·4PL 필수)
unipass-connector(관세청 통관/화물진행) · hometax-connector(전자세금계산서) · bank-connector(펌뱅킹/오픈뱅킹 입출금) · swift-connector(L/C MT700/707) · carrier-edi(선사/포워더 부킹·추적) · ktnet-connector(전자무역 uTradeHub) · webhook-gateway(내외부 이벤트)
> 모듈마다 흩어지면 유지보수 지옥. 대외 연동은 전부 이 도메인에 모아 어댑터 패턴으로 표준화.

### ⑮ planning (계획 = SAP APO/IBP 경량, 제조 필수)
demand-forecast(수요예측) · sop(판매운영계획 S&OP) · supply-planning(공급계획) → manufacturing.mrp의 입력원

### ⑯ portal (셀프서비스 포털, 외부 노출)
employee-self-service(ESS: 급여명세·연차신청·경비제출) · manager-self-service(MSS: 승인·팀근태) · client-visibility(4PL 고객 화물추적 가시성 — 대기업 4PL 핵심 경쟁력) · vendor-portal(공급사 PO/송장 조회)

### ⑰ contract (계약·SLA 관리)
sales-contract · purchase-contract · service-contract(4PL 서비스 계약: 요율·갱신·SLA 준수 추적) · sla-monitoring(KPI/SLA 위반 알림)

### 횡단 기능 (도메인 아님, 여러 도메인에 박히는 공통)
- **landed-cost(수입부대비용 배부)**: 수입원가 = PO단가 + 운임 + 관세 + 보험 + 통관비를 품목별 배부 → inventory 재고원가 + product-costing 반영. procurement·logistics-4pl·inventory·finance 교차. **수입제조사 필수.**
- **fi-posting**: 모든 거래의 회계 분개 표준화(아래 3장).

### analytics (분석/보고)
dashboard(도메인별 KPI) · standard-report · bi(Metabase 연계)

> **후순위(나중에 경량 추가)**: PM(설비보전 — 제조사라 정비이력 경량 버전 권장) · budgeting(예산 예실대비, CO 확장) · grc(권한분리 SoD/내부통제) · trade-finance(무역금융·수출보험 K-SURE·수출환어음매입, treasury+trade 경량) · collections-dispute(수금·독촉·분쟁, AR 확장) · fx-reporting(외국환거래 보고) · ga-asset(총무 운영자산·비품·차량).
> **의도적 제외**: PS(프로젝트 — 수주형 맞춤제작 생기면) · 부동산/EHS(규모 과잉, 단 산업안전보건 법적의무는 별도) · 다법인 연결결산 · ESG · 리스회계(K-IFRS 1116, 리스 많으면 재검토).

---

## 2. 신규 도메인 핵심 데이터 모델

기존(L/C·통관·FTA·더블엔트리)은 앞 설계 그대로 두고, 새로 들어가는 도메인만 핵심 테이블을 잡는다.

### HR / 한국 급여
```
employee(emp_id, emp_no, name, rrn_enc(주민번호 암호화), hire_date, term_date,
         dept_id, position_id, job_id, employment_type, bank_acct, status)
org_unit(org_id, parent_id, type, name, cost_center_id)        -- 조직 트리(recursive)
payroll_run(run_id, period_ym, status, pay_date)
payroll_item(item_id, run_id, emp_id, comp_type, amount, taxable)  -- 지급/공제 명세
  comp_type 예: BASE(기본급) OT(연장) NIGHT(야간) HOLIDAY(휴일) MEAL(식대,비과세)
               NPS(국민연금) NHI(건강보험) LTC(장기요양) EI(고용보험)
               INCOME_TAX(소득세) LOCAL_TAX(지방소득세)
insurance_rate(rate_id, ins_type, effective_from, employee_pct, employer_pct, ceiling)
  -- ⚠️ 4대보험 요율은 매년 변동 → 절대 하드코딩 금지, effective_from으로 조회
attendance(att_id, emp_id, work_date, clock_in, clock_out, ot_minutes, leave_type)
annual_leave(emp_id, year, granted_days, used_days, remaining)  -- 1년미만 월1일, 1년+ 15일+가산
severance(emp_id, calc_base_3m_avg, service_years, amount, type)  -- DB/DC
year_end_tax(emp_id, tax_year, total_income, deductions_json, determined_tax, settled_amount)
```
한국 급여 규칙(구조만, 요율은 insurance_rate로 파라미터화):
- 4대보험 = 국민연금·건강보험(+장기요양)·고용보험·산재보험(산재는 사업주 전액). 요율 **매년 변동** → 테이블 조회.
- 소득세 = 간이세액표(월급여×부양가족수). 지방소득세 = 소득세 ×10%.
- 비과세(식대 등) 분리, 연장·야간·휴일수당 가산(통상임금 기준).
- 퇴직금 = 3개월 평균임금 ×30일 ×재직연수(또는 퇴직연금 DB/DC).
- 연말정산은 복잡 → 1차는 "데이터 보관 + 외부 세무 연계", 자동계산은 후순위.

### CRM
```
crm_account(account_id, bp_id, industry, tier, owner_emp_id)
crm_contact(contact_id, account_id, name, title, email, phone)
crm_lead(lead_id, source, status, account_id, est_value, owner_emp_id)
crm_opportunity(opp_id, account_id, stage, amount, currency, prob_pct, close_date, owner_emp_id)
  stage: PROSPECT→QUALIFY→PROPOSAL→NEGOTIATION→WON/LOST
crm_activity(act_id, type, ref_type, ref_id, due_date, done, note)
crm_campaign(camp_id, name, budget, start, end, target_segment)
crm_service_ticket(ticket_id, account_id, subject, priority, status, assignee_emp_id)
```
opportunity가 WON → sales.sales_order 생성으로 연결.

### Treasury (재무)
```
cash_position(date, bank_acct_id, currency, opening, inflow, outflow, closing)
bank_transaction(txn_id, bank_acct_id, txn_date, amount, dr_cr, raw_payload, matched_doc)
  -- 펌뱅킹/오픈뱅킹 실거래, FI 미결제항목과 자동매칭
fx_position(pos_id, currency, amount, type, deal_date, maturity, rate, counterparty)
payment_proposal(prop_id, run_date, status) + payment_item(prop_id, ap_doc_id, amount)
borrowing(loan_id, lender_bp_id, principal, rate, draw_date, maturity, repay_schedule_json)
```

### Logistics 4PL (심화 — 비중 가장 큼)
```
shipment(shp_id, shp_no, mode(SEA/AIR/RAIL/TRUCK), direction(EXP/IMP), client_bp_id,
         incoterms, pol, pod, etd, eta, status, fcl_lcl)
hbl(hbl_id, shp_id, shipper, consignee, notify, marks, pkg, weight, volume_cbm)  -- House B/L
mbl(mbl_id, carrier_bp_id, vessel_voyage, container_no)                          -- Master B/L
consolidation(cons_id, mbl_id) + cons_item(cons_id, hbl_id)                      -- 콘솔(LCL 혼재)
carrier_rate(rate_id, carrier_bp_id, lane, container_type, rate, currency, valid_from, valid_to)
transport_leg(leg_id, shp_id, seq, mode, from_loc, to_loc, carrier_bp_id, cost, sell)
tracking_event(evt_id, shp_id, milestone, location, event_time, source)  -- UNI-PASS/선사 연동
wms_client_stock(cs_id, client_bp_id, material, location, qty)  -- 3PL: 화주별 재고분리(소유권 화주)
logistics_charge(chg_id, shp_id, charge_type, basis, cost_amt, sell_amt, currency, vendor_bp_id)
  charge_type: OCEAN_FREIGHT/THC/DUTY/VAT/CUSTOMS_FEE/DOC_FEE/HANDLING/INSURANCE/...
logistics_invoice(inv_id, client_bp_id, shp_id) + line(inv_id, chg_id)  -- 화주 청구
  -- 예정원가(accrual) vs 실제원가 차이 → 마진(sell-cost) 자동 산출 → FI 연계
```
4PL 정산 핵심: **shipment별로 매출(sell)·원가(cost)를 charge 단위로 쌓고, 예정→실제 차액을 accrual로 잡아 건별 손익을 실시간 산출.** 이게 포워딩/4PL 시스템의 심장.

---

## 3. FI 통합 원칙 (모든 도메인 공통)

거래가 발생하는 모든 모듈은 자체 DB 저장과 동시에 **회계 분개를 자동 생성**해 general-ledger로 던진다.
- SD 청구 → (차) 외상매출금 / (대) 제품매출 + 부가세예수금
- MM 입고 → (차) 재고자산 / (대) 미착품 또는 외상매입금
- Payroll 급여확정 → (차) 급여 / (대) 예수금(4대보험·세금)+미지급급여
- Logistics 청구 → (차) 외상매출금 / (대) 용역매출 ; 원가 → (차) 외주운송비 / (대) 미지급금

→ fi-posting 공통 서비스 + Skill 하나로 표준화. 도메인마다 분개 다시 짜지 말 것.

---

## 3-B. 구조 설계 원칙 (효율화 — 17개 도메인을 스파게티 없이)

기능보다 이게 더 중요. 아래 9개는 **CLAUDE.md 전역 규칙**으로 박아서 모든 도메인이 따르게 한다.

1. **모듈러 모놀리스 (마이크로서비스 금지)** — 단일 백엔드(apps/api) 안에 domains/ 폴더로 분리. 1~2인 + Claude Code엔 마이크로서비스는 자살. 도메인 간 경계는 모듈 경계로만.
2. **공통 문서 프레임워크** — 모든 거래문서가 공유하는 [헤더+아이템+상태+채번+audit 4컬럼+첨부+거래처참조+FI분개훅]을 베이스 엔티티/패턴으로 1회 정의 후 상속. 도메인별 재구현 금지.
3. **문서 흐름(Document Flow) 테이블** — `doc_flow(source_type, source_id, target_type, target_id, rel_type)` 범용 테이블로 수주→출하→청구→FI, 기회→수주 등 전 체인 추적(SAP식 드릴다운). 개별 FK link 난립 금지.
4. **마스터 확장/역할 패턴** — 코어 마스터 + 도메인별 확장테이블(material→material_sales/purchasing/mrp/trade; BP→customer/vendor/carrier 역할). 거대 단일테이블도 복사본도 아님.
5. **계정결정 + fi-posting 엔진** — (거래유형·자재그룹 등 → GL계정) 매핑을 `account_determination` config 테이블로. 회계담당이 코드 수정 없이 변경. 분개계정 하드코딩 금지.
6. **공통 가격/조건 엔진** — SD단가·PO단가·선사운임·물류charge가 하나의 pricing(condition) 엔진 재사용. 도메인별 가격로직 중복 금지.
7. **도메인 이벤트 버스** — `BillingPosted` 같은 도메인 이벤트 발행 → AR·FI·Treasury·analytics 핸들러가 구독. 도메인 간 직접 호출 최소화(인프로세스 EventEmitter, 비동기는 BullMQ).
8. **모듈 스캐폴드 제너레이터(Skill)** — `erp-module-scaffold`가 [엔티티→마이그레이션→레포→서비스→컨트롤러→DTO→테스트→CRUD화면]을 동일 형태로 생성. 17개 도메인 일관성·속도의 핵심.
9. **리포팅은 read model/MV** — 대시보드는 이벤트로 갱신되는 읽기전용 뷰/머티리얼라이즈드뷰 또는 Metabase(복제본). 17개 도메인 라이브 조인으로 OLTP 때리지 말 것.

> 추가 전역 규칙: 권한은 `domain:subject:action` 네이밍 1회 정의 · API는 공통 베이스 컨트롤러로 페이징·필터·에러포맷 통일 · 회계기간/회계연도 통제는 admin-config에 흡수.
> **구조 보강 2**: (a) 엔드투엔드 타입 안전성 — REST 유지하되 OpenAPI에서 타입 클라이언트 자동생성(orval/openapi-typescript)으로 BE 타입→FE 무드리프트. (b) 커널 패키지 — 공통패턴(문서프레임워크·이벤트버스·계정결정·가격엔진)은 `packages/kernel`에 집결.

---

## 3-C. 비기능 요구사항 & 품질 (ERP의 본체 — 빠지면 신뢰 붕괴)

**🔴 필수 (재무 정합성·법적, 타협 불가)**
1. **전표 불변성 + 역분개** — 전기(posted)된 journal_entry는 수정·삭제 금지, 역분개(reversal)로만 정정. 회계감사·세무 기본. period locking으로 마감기간 전기 차단.
2. **분개 멱등성 + Outbox 패턴** — 이벤트 연쇄(BillingPosted→AR→FI→Treasury) 시 중복전기 방지. outbox 테이블로 정확히 1회(exactly-once) 보장. 모든 FI 포스팅에 idempotency key.
3. **개인정보보호(PIPA) 보안** — 주민번호·계좌·급여 암호화 저장(at-rest) + 접근감사 + 화면 마스킹. 시크릿은 환경변수/시크릿매니저. 입력검증(Zod)·인증·인가 전 계층. 위반 시 과태료.
4. **계산 로직 단위테스트 의무** — 급여(4대보험·수당)·landed-cost 배부·4PL 건별마진·외화환산·관세환급은 틀리면 돈이 틀림 → Vitest 단위테스트 강제(엣지케이스 포함). 회계 포스팅은 Testcontainers 통합테스트.

**🟡 운영 (개발 중 병행)**
5. **대용량 파티셔닝** — journal_line·tracking_event·bank_transaction·logistics_charge는 기간 파티셔닝 + 인덱스 전략 + 오래된 데이터 아카이빙(수년 운영 가정).
6. **관측성·백업·DR** — Pino 로깅 + Sentry 에러추적 + Prometheus/Grafana 모니터링 + DB 자동백업(RPO/RTO 정의).
7. **환경 분리 + 시드데이터** — dev/staging/prod 분리, 운영DB 직접 테스트 금지, 도메인별 seed/demo 데이터.

**🟢 프로젝트 (코드 밖, 필수)**
8. **이관·전환(cutover) 계획** — 기존 엑셀/구ERP → 신규 전환 시 병행운영 + 데이터 검증 + 기초잔액 적재 + 전환일(cutover date) 계획. data-migration 도구와 별개.
9. **사용자 교육·매뉴얼** — 도메인별 사용자 가이드. 안 쓰면 무용지물.

**기능 깊이 보강(모듈 아님)**: period-close는 [보조원장 마감→대사→발생주의→외화 기말평가→GL마감] 체크리스트형 오케스트레이션으로 · 외화평가(revaluation)는 미결제 AR/AP 기말환율 재평가 로직 명시.

---

## 4. 균형 개발 로드맵 (전 도메인, 의존성 순서)

풀 ERP라 현실적으로 **1~2인 + Claude Code로 10~12개월** 규모. 전략은 **"도메인별 수직 슬라이스"** — 각 도메인을 한 번에 완성하려 말고, 먼저 [마스터 → 핵심 거래 1개 → FI 연계 → 기본 화면/리포트]만 얇게 관통시킨 뒤, 무역/4PL만 깊게 판다.

| Phase | 도메인 | 핵심 산출물 | 기간 |
|---|---|---|---|
| 0 | platform | 인증·권한·조직구조·채번·감사로그 | 2~3주 |
| 1 | master-data | 품목·BP·계정과목·통화/환율·코스트센터·세금코드 | 3주 |
| 2 | finance-accounting | 더블엔트리 GL·AR·AP (전 도메인의 등뼈) | 3~4주 |
| 3 | procurement + inventory + **landed-cost** | PR→PO→GR→IV + 재고(이동평균) + 수입부대비용 배부 → FI | 4~5주 |
| 4 | sales + **contract** | 견적→수주→출하→청구 + 계약/SLA → FI | 4주 |
| 5 | crm + **portal(고객 가시성)** | 고객·리드·기회·활동 → SD 연계 + 4PL 화물추적 포털 | 3~4주 |
| 6 | manufacturing-quality + **planning** | 수요예측→S&OP→MRP→작업지시·품질검사 | 5주 |
| 7 | trade-compliance + **integration** | L/C·통관·FTA·HS·서류 + 대외연계(UNI-PASS·홈택스·SWIFT·KTNET) | 5주 |
| 8 | logistics-4pl (가장 심화) | 포워딩·TM·추적·물류정산 | 6주 |
| 9 | hr-payroll + **portal(ESS/MSS)** | 조직·인사·근태·급여(4대보험)·퇴직금 + 직원 셀프서비스 | 5~6주 |
| 10 | treasury | 자금관리·환위험·펌뱅킹·지급실행 | 3주 |
| 11 | controlling + analytics | CO-PA·제품원가·도메인 대시보드 | 3주 |
| 12 | 통합·마감·배포 | 월말마감·권한정비·운영배포 | 3주 |

MVP: Phase 0~4(기반+마스터+회계+구매재고+영업)가 **최소 동작 ERP**. 이게 돌면 회사 핵심 업무는 이미 굴러감. 이후 5~12는 가치 큰 순서로 붙임(무역사면 7·8을 4 다음으로 당겨도 OK).

---

## 5. Claude Code 운영 전략 (큰 스코프 + 웹 버전 기준)

- **루트 CLAUDE.md**(200줄 이하): 프로젝트 정의 · 스택 · 전역 규칙(돈 NUMERIC(18,2), 모든 거래 fi-posting 경유, snake_case, audit 4컬럼, soft-delete 금지, 권한 domain:subject:action) · **구조 설계 원칙(3-B 요약)** · **비기능 규칙(3-C 요약: 전표 불변성·멱등성·PIPA 암호화·계산로직 테스트)** · 도메인 지도 인덱스(이 문서 링크).
- **도메인별 CLAUDE.md**: domains/<도메인>/CLAUDE.md에 그 도메인 전용 규칙·용어·핵심 테이블만. 그 폴더 작업 시 자동 추가 로드.
- **docs/ 분할**: docs/domains/hr.md, docs/domains/logistics-4pl.md 식으로 상세 스펙 분리. 한 파일에 다 넣지 말 것.
- **한 번에 한 도메인(=한 PR)**: 새 세션 → 도메인 수직 슬라이스만 → PR 머지 → 다음. "ERP 전체 만들어줘" 한 방 금지.
- **Skills**: fi-posting-validator(분개 dr=cr 검증) · drizzle-migration · korean-payroll-calc(4대보험/수당) · mt700-parser · logistics-margin-calc(건별 sell-cost) · unipass-api-client.
- **Subagents**: db-architect · security-reviewer(주민번호 암호화 점검) · test-runner · domain-checker.

### ⚠️ 웹 버전만으로 풀 ERP를 끝까지 짓는 건 위험 — 꼭 읽기
Claude Code 웹은 코드 생성 + GitHub PR엔 완벽. 그러나 **"실제로 돌려서 화면 클릭하고 DB 마이그레이션 적용하고 버그 잡는" 단계는 웹만으론 부족**. 17개 도메인을 안 돌려보고 코드만 쌓으면 나중에 한꺼번에 터진다.

권장: **Phase 0~2(기반+마스터+회계)까지 웹으로 생성한 뒤, 그 시점에 "실제 실행 환경"을 한 번 만든다.**
1. 로컬 최소 설치(Git + Claude Code 터미널 + Docker로 Postgres) — 웹 세션을 `--teleport`로 터미널로 끌어와 이어감.
2. 또는 싼 클라우드 개발환경(Railway $5/월 등)에 붙여 실행.

핵심: **"웹으로 짓고, 일찍부터 어딘가에서 실제로 돌려보며 검증."** 안 돌려보고 9개월 코딩이 가장 큰 함정.

---

## 6. 지금 Claude Code에 던질 첫 작업

repo는 SAP-ERP · main 선택 상태에서, **이 문서를 + 버튼으로 첨부**하고 아래를 입력창에 복붙:

```
이 repo에 풀 엔터프라이즈 ERP를 만들 거야. 첨부한 docs/architecture-full.md가 설계서야.
지금은 앱(도메인) 코드는 짓지 말고, 아래 "기반 골격 + 거버넌스"만 세팅해줘:

[1] 모노레포 골격 (Turborepo + pnpm workspaces)
   apps/web      = Next.js 16 (App Router, TS strict)
   apps/api      = NestJS 11
   apps/worker   = BullMQ 워커 (빈 골격)
   packages/kernel  = 횡단 공통패턴이 살 곳 (문서프레임워크·이벤트버스·fi-posting·계정결정·가격엔진) — 지금은 폴더+인터페이스 스텁만
   packages/db      = Drizzle 스키마/마이그레이션 (drizzle.config.ts)
   packages/shared  = Zod DTO·공통 enum(Incoterms/MT 등)
   packages/ui      = 공통 React 컴포넌트 (shadcn/ui)
   packages/config  = eslint/tsconfig/prettier 공유
   packages/trade-data = HS CSV·FTA협정·SPL 리스트 (빈 폴더)

[2] 루트 CLAUDE.md (200줄 이하) — 반드시 아래를 전부 인코딩:
   · 프로젝트 정의 + 기술 스택
   · 전역 규칙: 돈은 NUMERIC(18,2), 모든 거래는 fi-posting 경유, snake_case,
     audit 4컬럼(created_at/by, updated_at/by), soft-delete 금지, 권한 domain:subject:action
   · 구조 설계 원칙(문서 3-B): 모듈러 모놀리스 / 공통 문서프레임워크(header+item 베이스) /
     문서흐름 테이블(doc_flow) / 마스터 확장·역할 패턴 / 계정결정 config / 공통 가격엔진 /
     도메인 이벤트 버스 / 모듈 스캐폴드 / 리포팅은 read model
   · 비기능 규칙(문서 3-C): 전표 불변성+역분개 / 분개 멱등성(Outbox) /
     PIPA 보안(주민번호·계좌·급여 암호화+접근감사+마스킹) / 계산로직 단위테스트 의무
   · 도메인 지도 인덱스(@docs/architecture-full.md 참조)

[3] docs/phase-plan.md — 문서 4장의 Phase 0~12 로드맵 정리 (수직 슬라이스 원칙 명시)

[4] docker-compose.yml — PostgreSQL 16 + Redis 7

[5] 테스트 툴체인 — Vitest(단위) + Playwright(e2e) + Testcontainers(통합) 설정 + 예제 1개

[6] 도메인별 CLAUDE.md 빈 템플릿 — apps/api/src/domains/<도메인>/CLAUDE.md 스캐폴드

완료되면 Phase 0(platform: auth·rbac·org-structure·numbering·workflow·admin-config·
data-migration·output-forms + packages/kernel 공통패턴 구현) 시작 전에 멈추고
무엇을 어떤 순서로 짤지 계획부터 보여줘. (계획 승인 전 코드 작성 금지)
```

> 참고: 이 첫 작업이 끝나면 Phase 0에서 packages/kernel의 횡단패턴(문서프레임워크·이벤트버스·fi-posting·계정결정·가격엔진)을 실제 구현한다. 이게 있어야 이후 14개 도메인이 같은 뼈대 위에 얹혀 스파게티를 피한다.
