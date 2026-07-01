#!/usr/bin/env python3
"""Slide content for the RIOS executive deck. Imports helpers/prs from build_deck."""
from build_deck import *  # noqa
from build_deck import _noshadow, _mix  # underscore names skipped by import *
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

N = [0]
def pn():
    N[0] += 1
    return N[0]

# ============================================================== 1. COVER
def cover():
    s = slide(WHITE)
    rect(s, 0, 0, 13.333, 7.5, fill=None, rounded=False)
    # left panel
    lp = rect(s, 0, 0, 5.6, 7.5, fill=INK, rounded=False)
    accent_bar(s, 0, 0, 0.16, 7.5, BLUE)
    # logo mark
    m = s.shapes.add_shape(MSO_SHAPE.HEXAGON, Inches(0.9), Inches(0.9), Inches(0.62), Inches(0.62))
    _noshadow(m); m.fill.solid(); m.fill.fore_color.rgb = BLUE; m.line.fill.background()
    text(s, 1.62, 0.92, 3.5, 0.6, [[('RIOS', 24, WHITE, True)]])
    text(s, 1.62, 1.35, 4, 0.3, [[('Reinsurance Intelligent OS', 10, MUTE, False)]])
    text(s, 0.9, 2.7, 4.4, 2.2, [
        [('Reinsurance', 34, WHITE, True)],
        [('Intelligence &', 34, WHITE, True)],
        [('Operations Suite', 34, RGBColor(0x93,0xC5,0xFD), True)],
    ], line_spacing=1.02)
    text(s, 0.9, 5.0, 4.4, 1.0, [[('The next-generation unified platform that replaces the disconnected systems running modern reinsurance.', 13, RGBColor(0xC7,0xD2,0xFE), False)]], line_spacing=1.2)
    for i, (t, c) in enumerate([('AI-Native', GREEN), ('Cloud-Ready', BLUE), ('One Data Model', AMBER)]):
        chip(s, 0.9 + i*1.5, 6.4, 1.4, t, fill=RGBColor(0x1E,0x29,0x3B), fg=c)
    # right — product hero
    text(s, 6.1, 0.95, 6.6, 0.4, [[('ENTERPRISE DIGITAL PLATFORM FOR MODERN REINSURANCE', 11, BLUE, True)]])
    browser_frame(s, 'executive.png', 6.1, 1.5, 6.5, addr='app.rios.cloud/executive')
    text(s, 6.1, 6.7, 6.6, 0.4, [[('Place  ›  Bind  ›  Account  ›  Reconcile  ›  Claims  —  on one platform.', 12, SLATE, True)]])

# ============================================================== 2. ABOUT
def about():
    s = slide(BG); accent_bar(s); kicker(s, 'About RIOS'); title(s, 'One platform. One data model. One source of truth.')
    text(s, 0.9, 1.75, 7.2, 1.4, [[('RIOS unifies the entire reinsurance value chain — placement, underwriting, treaty & facultative administration, accounting, claims, analytics and the back office — into a single, metadata-driven, multi-tenant operating system. No more spreadsheets, email threads and swivel-chair integration between a dozen legacy tools.', 14, SLATE, False)]], line_spacing=1.25)
    cards = [('Vision', 'The connective tissue of a reinsurer — every workflow, entity and decision in one governed system.', BLUE, '◆'),
             ('Mission', 'Replace fragmented legacy suites with a correct, secure, audited and AI-native platform.', INDIGO, '◇'),
             ('Approach', 'Metadata-driven configuration, integer-accurate money, hash-chained audit, role-based access.', GREEN, '❖')]
    for i, (h, b, c, g) in enumerate(cards):
        x = 0.9 + i*4.05
        rect(s, x, 3.4, 3.8, 3.1, fill=WHITE, line=LINE, radius=0.06)
        icon_tile(s, x+0.35, 3.75, g, c)
        text(s, x+0.35, 4.55, 3.1, 0.4, [[(h, 16, INK, True)]])
        text(s, x+0.35, 5.0, 3.15, 1.4, [[(b, 12, SLATE, False)]], line_spacing=1.2)
    page_no(s, pn())

# ============================================================== 3. PROBLEMS
def problems():
    s = slide(WHITE); accent_bar(s, color=AMBER); kicker(s, 'The Problem', color=AMBER)
    title(s, 'Reinsurance still runs on disconnected systems')
    items = [('Manual underwriting', 'Excel & email drive placement and pricing.'),
             ('Legacy, siloed suites', 'Policy, claims and finance never share one truth.'),
             ('Duplicate data entry', 'The same risk rekeyed across five systems.'),
             ('Slow pricing & placement', 'Days lost to spreadsheets and version chaos.'),
             ('No real-time visibility', 'Exposure and capacity are always yesterday’s.'),
             ('Fragmented reporting', 'Every return stitched together by hand.'),
             ('Regulatory complexity', 'Solvency II, IFRS 17 and audit run offline.'),
             ('No embedded AI', 'Zero decision support where underwriters work.')]
    for i, (h, b) in enumerate(items):
        col = i % 4; row = i // 4
        x = 0.9 + col*3.05; y = 1.9 + row*2.35
        rect(s, x, y, 2.85, 2.05, fill=BG, line=LINE, radius=0.07)
        icon_tile(s, x+0.28, y+0.28, '!', AMBER, size=0.5, gsize=18)
        text(s, x+0.28, y+0.9, 2.4, 0.4, [[(h, 13, INK, True)]])
        text(s, x+0.28, y+1.3, 2.45, 0.7, [[(b, 10.5, SLATE, False)]], line_spacing=1.12)
    page_no(s, pn())

# ============================================================== 4. WHY RIOS
def why_rios():
    s = slide(BG); accent_bar(s); kicker(s, 'Why RIOS'); title(s, 'Ten disconnected tools, replaced by one')
    items = [('Centralised platform','◈'),('Real-time collaboration','⇄'),('Workflow automation','⚙'),
             ('AI-assisted decisions','✦'),('Integrated claims','◎'),('Integrated finance','$'),
             ('Integrated HRMS','☰'),('Analytics & BI','▤'),('Compliance & audit','✓'),('Cloud-ready','☁')]
    for i, (h, g) in enumerate(items):
        col = i % 5; row = i // 5
        x = 0.9 + col*2.42; y = 2.0 + row*2.25
        rect(s, x, y, 2.25, 2.0, fill=WHITE, line=LINE, radius=0.08)
        icon_tile(s, x+0.28, y+0.3, g, [BLUE,INDIGO,GREEN,AMBER][(i)%4])
        text(s, x+0.28, y+1.15, 1.85, 0.7, [[(h, 12.5, INK, True)]], line_spacing=1.05)
    page_no(s, pn())

# ============================================================== 5. ARCHITECTURE
def architecture():
    s = slide(WHITE); accent_bar(s, color=INDIGO); kicker(s, 'Platform Architecture', color=INDIGO)
    title(s, 'A modern, layered enterprise architecture')
    layers = [('Experience','Web · Mobile · Portals · RIOS AI Assistant', BLUE),
              ('Business Modules','Underwriting · Distribution · Operations · Finance · HRMS · Analytics', INDIGO),
              ('Platform Services','Workflow Engine · Rules · Notifications · Audit · Search · AI Engine', GREEN),
              ('Data & Integration','Postgres (RLS) · Event Bus · API Gateway · ERP / CRM / Email / DMS · BI', AMBER)]
    y = 2.0
    for i, (h, b, c) in enumerate(layers):
        rect(s, 1.4, y, 8.4, 1.05, fill=_mix(c, WHITE, 0.10), line=None, radius=0.05)
        rect(s, 1.4, y, 0.14, 1.05, fill=c, rounded=False)
        text(s, 1.75, y+0.14, 3, 0.4, [[(h, 15, INK, True)]])
        text(s, 1.75, y+0.56, 7.9, 0.4, [[(b, 11.5, SLATE, False)]])
        if i < 3:
            a = s.shapes.add_shape(MSO_SHAPE.DOWN_ARROW, Inches(5.4), Inches(y+1.02), Inches(0.4), Inches(0.2))
            _noshadow(a); a.fill.solid(); a.fill.fore_color.rgb = MUTE; a.line.fill.background()
        y += 1.28
    # side rail
    rect(s, 10.2, 2.0, 2.5, 4.35, fill=INK, radius=0.06)
    text(s, 10.45, 2.25, 2.1, 0.4, [[('CLOUD-NATIVE', 11, RGBColor(0x93,0xC5,0xFD), True)]])
    for i, t in enumerate(['Multi-tenant + RLS','Zero-trust security','Hash-chained audit','Horizontal scale','CI/CD + observability','99.9% availability']):
        text(s, 10.45, 2.75+i*0.58, 2.1, 0.4, [[('•  '+t, 11, WHITE, False)]])
    page_no(s, pn())

# ============================================================== 6. PRODUCT OVERVIEW MAP
def product_overview():
    s = slide(BG); accent_bar(s); kicker(s, 'Product Overview'); title(s, 'Every module, one connected suite')
    groups = [('Overview', ['Dashboard','Executive Intelligence','AI Insights','Search','Mobile'], BLUE),
              ('Underwriting', ['Workbench','Treaty','Facultative','Placement','Pricing','Capacity & Exposure','Territory','Retrocession'], INDIGO),
              ('Distribution', ['Parties','Clients','Brokers','Cedents','CRM'], GREEN),
              ('Operations', ['Claims','Bordereaux','Recoveries','Workflow','Audit Log'], AMBER),
              ('Finance', ['Accounting','Statements','Treasury','Period Close','Procurement'], BLUE),
              ('Analytics & Compliance', ['Reports','Analytics','Risk & Capital','Regulatory','Compliance'], INDIGO),
              ('HRMS', ['People','Attendance','Payroll','Performance','Org Structure'], GREEN),
              ('Master Data', ['Products','Reference Data','LOB','Currencies'], AMBER),
              ('Documents', ['Repository','Templates','Knowledge Base'], BLUE),
              ('Integration', ['APIs','Connectors','Marketplace','Event Bus'], INDIGO),
              ('Administration', ['Security','Legal Entities','Delegation','Cost Mgmt'], GREEN),
              ('RIOS AI Assistant', ['NL Search','Copilot','Recommendations'], AMBER)]
    for i, (h, items, c) in enumerate(groups):
        col = i % 4; row = i // 4
        x = 0.9 + col*3.05; y = 1.85 + row*1.72
        rect(s, x, y, 2.85, 1.55, fill=WHITE, line=LINE, radius=0.07)
        rect(s, x, y, 2.85, 0.1, fill=c, rounded=False)
        text(s, x+0.22, y+0.16, 2.5, 0.35, [[(h, 12.5, INK, True)]])
        text(s, x+0.22, y+0.55, 2.5, 0.95, [[(' · '.join(items), 9, SLATE, False)]], line_spacing=1.1)
    page_no(s, pn())

# ============================================================== SECTION DIVIDER
def section(num, ttl, sub, color=BLUE):
    s = slide(INK)
    accent_bar(s, 0, 0, 0.16, 7.5, color)
    text(s, 0.9, 2.5, 2, 1.2, [[(num, 60, _mix(color, INK, 0.9), True)]])
    text(s, 0.9, 3.55, 10, 1.0, [[(ttl, 34, WHITE, True)]])
    text(s, 0.95, 4.5, 9.5, 0.8, [[(sub, 14, RGBColor(0xC7,0xD2,0xFE), False)]], line_spacing=1.2)
    rect(s, 0.95, 4.35, 0.8, 0.05, fill=color, rounded=False)
    return s

# ============================================================== MODULE SLIDE (workhorse)
def module_slide(kick, ttl, shot, purpose, features, benefits, kpis, ai, addr, color=BLUE):
    s = slide(WHITE); accent_bar(s, color=color); kicker(s, kick, color=color)
    title(s, ttl, size=26)
    text(s, 0.9, 1.62, 5.4, 0.9, [[(purpose, 12.5, SLATE, False)]], line_spacing=1.2)
    # screenshot right
    browser_frame(s, shot, 6.55, 1.5, 6.05, addr=addr)
    # features
    text(s, 0.9, 2.75, 5.4, 0.3, [[('KEY CAPABILITIES', 10.5, color, True)]])
    bullets(s, 0.9, 3.1, 5.5, 2.2, features, size=11.5, marker_color=color, gap=4)
    # KPI chips
    text(s, 0.9, 5.35, 5.4, 0.3, [[('BUSINESS IMPACT', 10.5, GREEN, True)]])
    for i, (lab, val) in enumerate(kpis):
        x = 0.9 + i*1.8
        rect(s, x, 5.7, 1.68, 1.0, fill=BG, line=LINE, radius=0.09)
        text(s, x, 5.8, 1.68, 0.4, [[(val, 18, GREEN, True)]], align=PP_ALIGN.CENTER)
        text(s, x, 6.24, 1.68, 0.4, [[(lab, 9, SLATE, False)]], align=PP_ALIGN.CENTER, line_spacing=1.0)
    # AI strip under screenshot
    rect(s, 6.55, 5.95, 6.05, 0.95, fill=_mix(INDIGO, WHITE, 0.08), radius=0.08)
    text(s, 6.8, 6.05, 1.2, 0.3, [[('AI  ✦', 12, INDIGO, True)]])
    text(s, 6.8, 6.38, 5.6, 0.5, [[('   '.join(ai), 10.5, SLATE, True)]], line_spacing=1.05)
    page_no(s, pn())

# ============================================================== WORKFLOW DIAGRAM
def workflow():
    s = slide(BG); accent_bar(s, color=GREEN); kicker(s, 'Enterprise Workflow', color=GREEN)
    title(s, 'From broker submission to AI-driven insight')
    steps = [('Broker','⇄',BLUE),('Cedent','◎',INDIGO),('Treaty','▤',BLUE),('Pricing','$',AMBER),
             ('Approval','✓',GREEN),('Finance','$',INDIGO),('Claims','◈',AMBER),('Reporting','▥',BLUE),
             ('Analytics','▤',INDIGO),('AI','✦',GREEN)]
    for i, (t, g, c) in enumerate(steps):
        col = i % 5; row = i // 5
        x = 0.95 + col*2.42; y = 2.2 + row*2.2
        rect(s, x, y, 2.05, 1.5, fill=WHITE, line=LINE, radius=0.1)
        icon_tile(s, x+0.72, y+0.24, g, c, size=0.6)
        text(s, x, y+0.95, 2.05, 0.4, [[(t, 13, INK, True)]], align=PP_ALIGN.CENTER)
        if col < 4:
            arrow(s, x+2.06, y+0.6, 0.34, 0.28, MUTE)
    text(s, 0.95, 6.6, 11, 0.4, [[('Every step is governed, audited and reconcilable — the same event stream feeds notifications, tasks, the audit log and the AI assistant.', 12, SLATE, True)]])
    page_no(s, pn())

# ============================================================== TECHNOLOGY
def technology():
    s = slide(WHITE); accent_bar(s, color=INDIGO); kicker(s, 'Technology', color=INDIGO)
    title(s, 'Built on a modern, proven stack')
    cols = [('Experience', ['React + Vite','Design-token system','Responsive & mobile','Accessible (WCAG)']),
            ('Services', ['Fastify (Node/TS)','Pure domain core','Workflow & rules engine','Event bus']),
            ('Data', ['PostgreSQL 16','Row-Level Security','Integer-money ledger','Hash-chained audit']),
            ('Platform', ['Docker + Kubernetes','CI/CD pipeline','Observability & metrics','Horizontal scale'])]
    for i, (h, items) in enumerate(cols):
        x = 0.9 + i*3.05
        rect(s, x, 2.0, 2.85, 4.3, fill=BG, line=LINE, radius=0.06)
        rect(s, x, 2.0, 2.85, 0.7, fill=_mix([BLUE,INDIGO,GREEN,AMBER][i], WHITE, 0.12), radius=0.06)
        text(s, x+0.28, 2.16, 2.4, 0.4, [[(h, 15, INK, True)]])
        bullets(s, x+0.28, 2.95, 2.4, 3.2, items, size=11.5, marker_color=[BLUE,INDIGO,GREEN,AMBER][i], gap=8)
    page_no(s, pn())

# ============================================================== SECURITY
def security():
    s = slide(BG); accent_bar(s); kicker(s, 'Security & Trust'); title(s, 'Enterprise-grade, zero-trust by design')
    items = [('Zero-trust access','Every request authenticated & authorised.'),
             ('RBAC + ABAC','Role and attribute-based, field-level security.'),
             ('SSO · SAML · MFA','Azure AD / Okta ready, TOTP second factor.'),
             ('Encryption','In transit and at rest; secrets managed.'),
             ('Tamper-evident audit','Hash-chained, append-only audit trail.'),
             ('Data isolation','Postgres Row-Level Security per tenant.'),
             ('Compliance-ready','Aligned to GDPR, ISO 27001, SOC 2.'),
             ('High availability','Resilient, observable, horizontally scaled.')]
    for i, (h, b) in enumerate(items):
        col = i % 4; row = i // 4
        x = 0.9 + col*3.05; y = 1.95 + row*2.35
        rect(s, x, y, 2.85, 2.05, fill=WHITE, line=LINE, radius=0.07)
        icon_tile(s, x+0.28, y+0.26, '✓', GREEN, size=0.5, gsize=18)
        text(s, x+0.28, y+0.88, 2.4, 0.4, [[(h, 12.5, INK, True)]])
        text(s, x+0.28, y+1.28, 2.45, 0.7, [[(b, 10.5, SLATE, False)]], line_spacing=1.12)
    page_no(s, pn())

# ============================================================== COMPARISON
def comparison():
    s = slide(WHITE); accent_bar(s, color=INDIGO); kicker(s, 'Competitive Comparison', color=INDIGO)
    title(s, 'How RIOS compares')
    rows = ['Unified platform','AI-native','Modern UX','Cloud-ready','Workflow automation',
            'Integrated HRMS','Integrated finance','API-first','Fast implementation']
    cols = ['RIOS','Legacy suites','Point solutions']
    x0, y0, wc, wr, hr = 0.9, 1.95, 2.0, 5.4, 0.5
    # header
    text(s, x0, y0, wr, hr, [[('Capability', 12, INK, True)]], anchor=MSO_ANCHOR.MIDDLE)
    for j, c in enumerate(cols):
        cx = x0 + wr + j*wc
        rect(s, cx, y0, wc-0.1, hr, fill=(BLUE if j==0 else BG), radius=0.06)
        text(s, cx, y0, wc-0.1, hr, [[(c, 12, (WHITE if j==0 else SLATE), True)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    for i, r in enumerate(rows):
        ry = y0 + hr + 0.08 + i*0.52
        if i % 2 == 0:
            rect(s, x0, ry, wr + 3*wc, 0.5, fill=BG, line=None, radius=0.03)
        text(s, x0+0.1, ry, wr, 0.5, [[(r, 11.5, INK, False)]], anchor=MSO_ANCHOR.MIDDLE)
        vals = [('●', GREEN), ('○', MUTE), ('◐', AMBER)]
        for j, (g, cc) in enumerate(vals):
            cx = x0 + wr + j*wc
            text(s, cx, ry, wc-0.1, 0.5, [[(g, 16, cc, True)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, x0, 6.7, 11, 0.3, [[('●  Full     ◐  Partial     ○  Limited / none', 10, SLATE, False)]])
    page_no(s, pn())

# ============================================================== BUSINESS BENEFITS
def benefits():
    s = slide(BG); accent_bar(s, color=GREEN); kicker(s, 'Business Benefits', color=GREEN)
    title(s, 'Outcomes that move the P&L')
    data = [('+40%','Underwriting productivity',BLUE),('−55%','Claims processing time',INDIGO),
            ('−70%','Manual data errors',GREEN),('+100%','Compliance visibility',AMBER),
            ('1','Single source of truth',BLUE),('−35%','Operational cost',INDIGO),
            ('Real-time','Exposure & capacity',GREEN),('Faster','Placement & pricing',AMBER)]
    for i, (v, l, c) in enumerate(data):
        col = i % 4; row = i // 4
        x = 0.9 + col*3.05; y = 2.0 + row*2.35
        rect(s, x, y, 2.85, 2.05, fill=WHITE, line=LINE, radius=0.08)
        text(s, x, y+0.35, 2.85, 0.7, [[(v, 30, c, True)]], align=PP_ALIGN.CENTER)
        text(s, x+0.2, y+1.25, 2.45, 0.7, [[(l, 12, SLATE, True)]], align=PP_ALIGN.CENTER, line_spacing=1.05)
    page_no(s, pn())

# ============================================================== ROI (chart)
def roi():
    s = slide(WHITE); accent_bar(s); kicker(s, 'Return on Investment')
    title(s, 'Value compounds from year one')
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
    cd = CategoryChartData()
    cd.categories = ['Year 1', 'Year 2', 'Year 3']
    cd.add_series('Automation savings', (1.2, 2.1, 2.9))
    cd.add_series('Productivity gains', (0.8, 1.9, 2.6))
    cd.add_series('Compliance & risk', (0.5, 1.1, 1.6))
    gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_STACKED, Inches(0.9), Inches(2.0),
                            Inches(7.2), Inches(4.6), cd)
    ch = gf.chart; ch.has_legend = True; ch.legend.position = XL_LEGEND_POSITION.BOTTOM
    ch.legend.include_in_layout = False
    try:
        ch.plots[0].gap_width = 80
        cols = [BLUE, INDIGO, GREEN]
        for si, ser in enumerate(ch.series):
            ser.format.fill.solid(); ser.format.fill.fore_color.rgb = cols[si]
    except Exception:
        pass
    text(s, 8.4, 2.1, 4.2, 0.4, [[('CUMULATIVE VALUE (USD, $M — illustrative)', 10.5, BLUE, True)]])
    cards = [('< 12 mo','Payback period',GREEN),('3.8×','3-year ROI',BLUE),('−35%','TCO vs legacy',INDIGO)]
    for i, (v, l, c) in enumerate(cards):
        y = 2.7 + i*1.3
        rect(s, 8.4, y, 4.1, 1.1, fill=BG, line=LINE, radius=0.08)
        text(s, 8.6, y+0.16, 1.6, 0.7, [[(v, 24, c, True)]])
        text(s, 10.1, y+0.32, 2.3, 0.5, [[(l, 12, SLATE, True)]], anchor=MSO_ANCHOR.MIDDLE)
    page_no(s, pn())

# ============================================================== JOURNEY
def journey():
    s = slide(BG); accent_bar(s, color=AMBER); kicker(s, 'Customer Journey', color=AMBER)
    title(s, 'A guided path from lead to continuous innovation')
    steps = ['Lead','Sales','Implementation','Migration','Training','Go-Live','Support','Innovation']
    y = 3.4
    for i, t in enumerate(steps):
        x = 0.9 + i*1.52
        c = [BLUE,INDIGO,GREEN,AMBER][i%4]
        d = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(0.5), Inches(0.5))
        _noshadow(d); d.fill.solid(); d.fill.fore_color.rgb = c; d.line.fill.background()
        text(s, x-0.35, y-0.02, 1.2, 0.5, [[(str(i+1), 16, WHITE, True)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        text(s, x-0.5, y+0.6, 1.5, 0.6, [[(t, 11.5, INK, True)]], align=PP_ALIGN.CENTER, line_spacing=1.0)
        if i < len(steps)-1:
            rect(s, x+0.5, y+0.22, 1.02, 0.06, fill=LINE, rounded=False)
    text(s, 0.9, 5.4, 11.5, 0.6, [[('Dedicated onboarding, phased data migration, role-based training and a continuous-innovation roadmap — de-risking your move to a unified platform.', 12.5, SLATE, False)]], line_spacing=1.2)
    page_no(s, pn())

# ============================================================== WHY CHOOSE
def why_choose():
    s = slide(WHITE); accent_bar(s); kicker(s, 'Why Choose RIOS'); title(s, 'Ten reasons leaders standardise on RIOS')
    items = ['Enterprise-ready & multi-tenant','Cloud-native & scalable','AI-first, embedded everywhere',
             'Modern, calm, premium UX','Truly integrated platform','Secure & compliant by design',
             'Configurable without code','Correct, audited, reconcilable','API-first & open','Future-ready roadmap']
    for i, t in enumerate(items):
        col = i % 2; row = i // 2
        x = 0.9 + col*6.1; y = 1.95 + row*0.92
        rect(s, x, y, 5.9, 0.78, fill=BG, line=LINE, radius=0.1)
        d = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x+0.22), Inches(y+0.2), Inches(0.38), Inches(0.38))
        _noshadow(d); d.fill.solid(); d.fill.fore_color.rgb = [BLUE,INDIGO,GREEN,AMBER][i%4]; d.line.fill.background()
        text(s, x+0.2, y+0.14, 0.5, 0.5, [[('✓', 13, WHITE, True)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        text(s, x+0.8, y, 5.0, 0.78, [[(t, 13, INK, True)]], anchor=MSO_ANCHOR.MIDDLE)
    page_no(s, pn())

# ============================================================== ROADMAP
def roadmap():
    s = slide(INK); accent_bar(s, color=BLUE)
    text(s, 0.9, 0.7, 8, 0.4, [[('ROADMAP', 11, RGBColor(0x93,0xC5,0xFD), True)]])
    text(s, 0.9, 1.05, 11, 0.8, [[('From foundation to autonomous reinsurance', 28, WHITE, True)]])
    ph = [('2026','Foundation','Unified platform, core modules, audit & security.',BLUE),
          ('2027','AI Expansion','Copilots across underwriting, claims and finance.',INDIGO),
          ('2028','Predictive Risk','Portfolio-level prediction, cat & capital modelling.',GREEN),
          ('2029','Global Marketplace','Connector marketplace & partner ecosystem.',AMBER),
          ('2030','Autonomous Platform','Straight-through, AI-governed reinsurance operations.',BLUE)]
    rect(s, 1.1, 3.35, 11.1, 0.05, fill=RGBColor(0x33,0x41,0x55), rounded=False)
    for i, (yr, h, b, c) in enumerate(ph):
        x = 1.1 + i*2.28
        d = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(3.2), Inches(0.34), Inches(0.34))
        _noshadow(d); d.fill.solid(); d.fill.fore_color.rgb = c; d.line.fill.background()
        text(s, x-0.4, 2.55, 1.2, 0.4, [[(yr, 16, WHITE, True)]], align=PP_ALIGN.CENTER)
        text(s, x-0.55, 3.75, 2.15, 0.5, [[(h, 13, c, True)]], line_spacing=1.0)
        text(s, x-0.55, 4.25, 2.15, 1.6, [[(b, 10.5, RGBColor(0xC7,0xD2,0xFE), False)]], line_spacing=1.15)
    page_no(s, pn())

# ============================================================== THANK YOU
def thankyou():
    s = slide(INK); accent_bar(s, color=BLUE)
    m = s.shapes.add_shape(MSO_SHAPE.HEXAGON, Inches(0.9), Inches(0.85), Inches(0.58), Inches(0.58))
    _noshadow(m); m.fill.solid(); m.fill.fore_color.rgb = BLUE; m.line.fill.background()
    text(s, 1.6, 0.9, 4, 0.5, [[('RIOS', 22, WHITE, True)]])
    text(s, 0.9, 2.7, 8, 1.4, [[('Let’s modernise', 40, WHITE, True)], [('your reinsurance operations.', 40, RGBColor(0x93,0xC5,0xFD), True)]], line_spacing=1.02)
    text(s, 0.95, 4.7, 7, 0.6, [[('Request a live demo and see the unified platform on your own book.', 14, RGBColor(0xC7,0xD2,0xFE), False)]])
    for i, (h, v) in enumerate([('Website','rios.cloud'),('Email','hello@rios.cloud'),('Demo','rios.cloud/demo')]):
        x = 0.95 + i*2.9
        rect(s, x, 5.7, 2.65, 0.95, fill=RGBColor(0x1E,0x29,0x3B), radius=0.1)
        text(s, x+0.25, 5.82, 2.3, 0.3, [[(h.upper(), 9, MUTE, True)]])
        text(s, x+0.25, 6.12, 2.3, 0.4, [[(v, 13, WHITE, True)]])
    # product cameo
    browser_frame(s, 'ai-insights.png', 9.4, 2.4, 3.4, addr='app.rios.cloud')

# ============================================================== MODULE CONTENT
MODULES = [
  ('OVERVIEW & INTELLIGENCE','Executive Intelligence & Dashboards','executive.png',
   'Real-time boardroom KPIs and eight persona dashboards (CEO, CFO, Chief UW, Ops, Finance, Claims, Portfolio, Risk) aggregated live across every module.',
   ['CEO / CFO / Chief-UW / Risk persona dashboards','GWP, combined ratio and technical result at a glance',
    'Trends, mix and drill-downs on one screen','Unified KPIs — no manual stitching'],
   [], [('8','Persona views'),('Live','Cross-module KPIs'),('1','Source of truth')],
   ['Grounded, explainable insights','No black-box scoring'], 'app.rios.cloud/executive', BLUE),

  ('OVERVIEW & INTELLIGENCE','AI Insights & Enterprise Search','ai-insights.png',
   'Deterministic, grounded AI insights across underwriting, claims, finance, portfolio and exposure — plus natural-language search and an in-context assistant.',
   ['Ranked, explainable observations per domain','Every insight carries a recommended action',
    'Natural-language search with saved searches','Works with AI disabled — auditable by design'],
   [], [('6','AI domains'),('NL','Search & assistant'),('0','Black boxes')],
   ['AI underwriting & claims lenses','Copilot recommendations'], 'app.rios.cloud/ai-insights', INDIGO),

  ('UNDERWRITING','Underwriting Workspace','underwriting.png',
   'The underwriting desk — submission workbench, referrals & approvals and analytics, unified with risk scoring and a guardrailed stage machine.',
   ['Submission triage, risk scoring & pipeline','Referral routing with approval matrix',
    'Pricing scenarios & CAT adapters','Collaboration, tasks and audit on every action'],
   [], [('+40%','UW productivity'),('Faster','Quote-to-bind'),('Full','Auditability')],
   ['AI risk scoring','Pricing recommendations'], 'app.rios.cloud/underwriting', BLUE),

  ('UNDERWRITING','Treaty Workspace','treaty.png',
   'The full treaty lifecycle in one workspace: register, a priced layer tower, versioning, clauses & wording, tax schedule, endorsements, technical account and timeline.',
   ['Priced layer tower (RoL, reinstatements, top)','Immutable versions & endorsements',
    'Special clauses, wording & tax schedule','Technical account and audit-stitched timeline'],
   [], [('1','Treaty cockpit'),('Reconciles','To zero'),('100%','Audited')],
   ['Layer pricing analytics','Clause suggestions'], 'app.rios.cloud/w/treaty', INDIGO),

  ('UNDERWRITING','Facultative Workspace','facultative.png',
   'An enterprise facultative desk — market quotes with comparison, a signed-down placement tower (lead / follow / coinsurance / retro) and engineering reports.',
   ['Market quotes with best-quote comparison','Signed-down placement & coinsurance lines',
    'Engineering / inspection reports','Placement timeline & completeness tracking'],
   [], [('Faster','Placement'),('Clear','Quote compare'),('Live','Signed order')],
   ['Best-quote selection','Placement gap detection'], 'app.rios.cloud/w/facultative', GREEN),

  ('UNDERWRITING','Capacity & Exposure','capacity-exposure.png',
   'Real-time capacity utilisation, exposure accumulation and the exposure-management console — with RAG alerts and forecasting across every dimension.',
   ['Capacity utilisation with RAG status & alerts','Exposure aggregation & peak-zone concentration',
    'Accumulation heatmaps & forecasts','Breach detection before you bind'],
   [], [('Real-time','Utilisation'),('Peak','Concentration'),('Proactive','Alerts')],
   ['Capacity recommendations','Exposure anomaly flags'], 'app.rios.cloud/w/capacity-exposure', AMBER),

  ('UNDERWRITING','Territory Workspace','territory.png',
   'The geographic master — country / state / city hierarchy plus CRESTA, peril and risk zones, each joined to live exposure with a blended risk score.',
   ['Country → state → city hierarchy','CRESTA / peril / postal / risk zones',
    'TIV & modelled PML per territory','Blended 0–100 risk score & severity bands'],
   [], [('Global','Zone taxonomy'),('Scored','Every zone'),('Live','Exposure link')],
   ['Zone risk scoring','Accumulation insights'], 'app.rios.cloud/w/territory', BLUE),

  ('UNDERWRITING','Pricing, Placement & Retrocession','pricing.png',
   'Actuarial pricing scenarios, placement management and outwards retrocession — with the gross / ceded / net position always reconciled.',
   ['Burning-cost, exposure & experience pricing','Placement lines and signed-down orders',
    'Retrocession protections & recoveries link','Adjustments (profit commission, sliding scale)'],
   [], [('Faster','Pricing'),('Net','Position live'),('Linked','To recoveries')],
   ['Rate recommendations','Scenario comparison'], 'app.rios.cloud/pricing', INDIGO),

  ('DISTRIBUTION','Distribution — Parties, Brokers, Cedents & CRM','parties.png',
   'A single counterparty backbone — parties, clients, brokers and cedents with a 360° profile, plus a CRM for pipeline, opportunities and communications.',
   ['Party 360 — contracts, claims, statements','Broker & cedent profitability and tiers',
    'CRM pipeline, opportunities & activities','Communication log and contact directory'],
   [], [('360°','Counterparty view'),('One','Relationship graph'),('Tracked','Every interaction')],
   ['Relationship insights','Next-best-action'], 'app.rios.cloud/parties', GREEN),

  ('OPERATIONS','Claims, Bordereaux & Recoveries','claims.png',
   'The claims lifecycle end-to-end — FNOL to settlement, bordereaux ingestion, reserves and recoveries — connected to treaties, finance and the audit log.',
   ['Claim lifecycle with reserves & payments','Bordereaux ingestion & reconciliation',
    'Recovery & cash-call tracking','Every movement audited and reconcilable'],
   [], [('−55%','Processing time'),('Linked','Treaty ↔ claim'),('Full','Recovery trace')],
   ['Claims triage & severity','Leakage detection'], 'app.rios.cloud/claims', AMBER),

  ('OPERATIONS','Workflow Center & Audit','workflow-engine.png',
   'The operational control tower — live workflow instances, SLA-scored tasks, an escalation queue, the approval matrix and a tamper-evident audit trail.',
   ['SLA scoring with tiered escalation','Approval matrix & delegation',
    'Notifications ↔ tasks ↔ workflow','Hash-chained, 100%-verified audit log'],
   [], [('SLA','Compliance %'),('Auto','Escalation'),('100%','Chain integrity')],
   ['SLA breach prediction','Bottleneck detection'], 'app.rios.cloud/workflow-engine', BLUE),

  ('FINANCE','Finance, Accounting & Treasury','accounting.png',
   'A complete finance back office — GL, AR/AP, statements of account, treasury, period close and procurement — fed by reconcilable financial events.',
   ['Balanced GL postings from financial events','Statements of account & technical accounts',
    'Treasury, bank & payment controls','Period close and procurement'],
   [], [('Reconciles','To zero'),('Integer','Accurate money'),('Audited','Every posting')],
   ['Cash-flow forecasting','Anomaly detection'], 'app.rios.cloud/accounting', INDIGO),

  ('ANALYTICS & COMPLIANCE','Analytics, Risk & Capital','risk-capital.png',
   'Portfolio analytics, catastrophe metrics (AAL / PML), risk & capital and solvency — with pivots, forecasts and executive-grade visualisation.',
   ['Portfolio pivots & catastrophe metrics','Risk appetite, capital & solvency views',
    'Reserving & development analytics','Forecasts and scenario analysis'],
   [], [('AAL/PML','Cat metrics'),('Capital','& solvency'),('Live','Portfolio view')],
   ['Predictive portfolio analysis','Capital optimisation'], 'app.rios.cloud/risk-capital', GREEN),

  ('ANALYTICS & COMPLIANCE','Regulatory, Compliance & Reporting','compliance.png',
   'A single assurance surface — audit dashboard, approvals, activity, a compliance calendar and regulatory returns — plus scheduled multi-format reports.',
   ['Audit dashboard & chain-integrity check','Approvals log, user activity & data access',
    'Compliance calendar & regulatory returns','Scheduled reports (PDF / Excel / CSV) + lists'],
   [], [('100%','Chain verified'),('Auto','Filings calendar'),('Multi','Format reports')],
   ['Regulatory change alerts','Report summarisation'], 'app.rios.cloud/compliance', INDIGO),

  ('CORPORATE & PLATFORM','HRMS — People, Payroll & Org','attendance.png',
   'An integrated HR back office — people, attendance, payroll, performance, assets and the organisation structure — removing a whole separate system.',
   ['People, attendance & leave','Payroll and performance reviews',
    'Assets and cost centres','Organisation structure & reporting lines'],
   [], [('−35%','Back-office cost'),('One','Employee record'),('Linked','Org → access')],
   ['Attendance anomalies','Workforce insights'], 'app.rios.cloud/attendance', GREEN),

  ('CORPORATE & PLATFORM','Master Data & Reference','products.png',
   'The governed reference layer — products, lines of business, currencies, countries, clauses and business rules — configured without deployment.',
   ['Products & coverage definitions','Lines of business, currencies, countries',
    'Code-lists as metadata (no hard-coded enums)','Add values without a release'],
   [], [('No-code','Configuration'),('Governed','Reference data'),('0','Deployments')],
   ['Data-quality suggestions','Rule validation'], 'app.rios.cloud/products', AMBER),

  ('CORPORATE & PLATFORM','Documents & Knowledge','documents.png',
   'An enterprise document hub — repository, templates, versioning, approval and a knowledge base — with search and document AI.',
   ['Central repository with versioning','Templates, clause & wording libraries',
    'Approval routing & retention','Knowledge base and SOPs'],
   [], [('One','Document hub'),('Versioned','& approved'),('Searchable','Everything')],
   ['OCR & extraction','Document summaries'], 'app.rios.cloud/documents', BLUE),

  ('CORPORATE & PLATFORM','Integration Hub & Automation','integration-hub.png',
   'Open by design — REST/GraphQL APIs, connectors (SAP, Oracle, Guidewire, Duck Creek), email/SMS/WhatsApp, webhooks, an event bus and automation studio.',
   ['REST & GraphQL APIs, webhooks','Connectors & marketplace',
    'Event bus & ETL','Automation studio, designer & scheduler'],
   [], [('API','First'),('Event','Driven'),('No-code','Automation')],
   ['Auto-mapping suggestions','Flow recommendations'], 'app.rios.cloud/integration-hub', INDIGO),

  ('CORPORATE & PLATFORM','Administration & Security','admin.png',
   'Everything administrators need — users, roles & permissions, legal entities, delegation, security operations, retention, cost management and feature flags.',
   ['RBAC + ABAC, field-level security','SSO / SAML / MFA, security operations',
    'Legal entities & delegation of authority','Retention, cost management & feature flags'],
   [], [('Zero-trust','Access'),('Field','Level security'),('Full','Governance')],
   ['Access anomaly detection','Policy recommendations'], 'app.rios.cloud/admin', GREEN),
]

# ============================================================== ASSEMBLE
cover()
about()
problems()
why_rios()
architecture()
product_overview()

sec = {'OVERVIEW & INTELLIGENCE':('01','Overview & Intelligence','Dashboards, executive KPIs, AI insights and enterprise search.',BLUE),
       'UNDERWRITING':('02','Underwriting','Treaty & facultative, pricing, capacity, exposure and territory.',INDIGO),
       'DISTRIBUTION':('03','Distribution','Parties, brokers, cedents, clients and the CRM.',GREEN),
       'OPERATIONS':('04','Operations','Claims, bordereaux, recoveries, workflow and audit.',AMBER),
       'FINANCE':('05','Finance','Accounting, statements, treasury, period close and procurement.',BLUE),
       'ANALYTICS & COMPLIANCE':('06','Analytics & Compliance','Analytics, risk & capital, regulatory, compliance and reporting.',INDIGO),
       'CORPORATE & PLATFORM':('07','Corporate & Platform','HRMS, master data, documents, integration and administration.',GREEN)}
seen = set()
for m in MODULES:
    kick = m[0]
    if kick not in seen:
        seen.add(kick)
        num, ttl, sub, col = sec[kick]
        section(num, ttl, sub, col)
    module_slide(*m)

workflow()
technology()
security()
comparison()
benefits()
roi()
journey()
why_choose()
roadmap()
thankyou()

out = os.path.join(BASE, 'RIOS_Enterprise_Presentation.pptx')
prs.save(out)
print('saved', out, '·', len(prs.slides._sldIdLst), 'slides')
