#!/usr/bin/env python3
"""Slide content for the RIOS product-walkthrough deck.

Grounded in what the application actually does — no invented metrics, no seeded
numbers. Every module slide reflects the real sidebar information architecture
and the real screens (embedded as live screenshots)."""
from build_deck import *  # noqa
from build_deck import _noshadow, _mix  # underscore names skipped by import *
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

N = [0]
def pn():
    N[0] += 1
    return N[0]


def chip_flow(s, x, y, maxw, items, color, size=9.5, ch=0.30, gap=0.12):
    """Flow a row of pill chips, wrapping within maxw. Returns bottom y."""
    cx, cy = x, y
    for it in items:
        w = max(0.62, 0.22 + len(it) * 0.062)
        if cx + w > x + maxw + 0.01:
            cx = x; cy += ch + gap
        rect(s, cx, cy, w, ch, fill=_mix(color, WHITE, 0.12), radius=0.5)
        text(s, cx, cy - 0.02, w, ch, [[(it, size, _mix(color, INK, 0.65), True)]],
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        cx += w + gap
    return cy + ch


# ============================================================== 1. COVER
def cover():
    s = slide(WHITE)
    lp = rect(s, 0, 0, 5.6, 7.5, fill=INK, rounded=False)
    accent_bar(s, 0, 0, 0.16, 7.5, BLUE)
    m = s.shapes.add_shape(MSO_SHAPE.HEXAGON, Inches(0.9), Inches(0.9), Inches(0.62), Inches(0.62))
    _noshadow(m); m.fill.solid(); m.fill.fore_color.rgb = BLUE; m.line.fill.background()
    text(s, 1.62, 0.92, 3.5, 0.6, [[('RIOS', 24, WHITE, True)]])
    text(s, 1.62, 1.35, 4, 0.3, [[('Reinsurance Intelligent OS', 10, MUTE, False)]])
    text(s, 0.9, 2.6, 4.4, 2.2, [
        [('Reinsurance', 33, WHITE, True)],
        [('Intelligence &', 33, WHITE, True)],
        [('Operations Suite', 33, RGBColor(0x93,0xC5,0xFD), True)],
    ], line_spacing=1.02)
    text(s, 0.9, 4.85, 4.4, 1.1, [[('A unified operating system for reinsurance — placement, underwriting, accounting, claims, analytics and the back office on one governed platform.', 12.5, RGBColor(0xC7,0xD2,0xFE), False)]], line_spacing=1.22)
    text(s, 0.9, 6.55, 4.4, 0.4, [[('Product Walkthrough', 12, WHITE, True)]])
    # right — product hero
    text(s, 6.1, 0.95, 6.6, 0.4, [[('ENTERPRISE PLATFORM FOR MODERN REINSURANCE', 11, BLUE, True)]])
    browser_frame(s, 'executive.png', 6.1, 1.5, 6.5, addr='app.rios.cloud/executive')
    text(s, 6.1, 6.7, 6.6, 0.4, [[('Place  ›  Bind  ›  Account  ›  Reconcile  ›  Claims  —  on one platform.', 12, SLATE, True)]])

# ============================================================== 2. ABOUT
def about():
    s = slide(BG); accent_bar(s); kicker(s, 'About RIOS'); title(s, 'One platform. One data model. One source of truth.')
    text(s, 0.9, 1.75, 11.4, 1.3, [[('RIOS unifies the reinsurance value chain — placement, underwriting, treaty & facultative administration, technical and general accounting, claims, analytics and the back office — into a single, metadata-driven, multi-tenant system, replacing the disconnected legacy tools and spreadsheets most reinsurers run today.', 14, SLATE, False)]], line_spacing=1.25)
    cards = [('What it is', 'A correct, secure, audited operating system covering the full place → bind → account → reconcile → claims lifecycle.', BLUE, '◆'),
             ('How it is built', 'Metadata-driven configuration, integer-accurate money, hash-chained audit and role-based access — foundations, not add-ons.', INDIGO, '◇'),
             ('Why it matters', 'The technical → financial chain reconciles to zero and every material change is audited — correctness you can inspect.', GREEN, '❖')]
    for i, (h, b, c, g) in enumerate(cards):
        x = 0.9 + i*4.05
        rect(s, x, 3.35, 3.8, 3.15, fill=WHITE, line=LINE, radius=0.06)
        icon_tile(s, x+0.35, 3.7, g, c)
        text(s, x+0.35, 4.5, 3.1, 0.4, [[(h, 16, INK, True)]])
        text(s, x+0.35, 4.95, 3.15, 1.5, [[(b, 11.5, SLATE, False)]], line_spacing=1.2)
    page_no(s, pn())

# ============================================================== 3. PROBLEMS
def problems():
    s = slide(WHITE); accent_bar(s, color=AMBER); kicker(s, 'The Problem', color=AMBER)
    title(s, 'Reinsurance still runs on disconnected systems')
    items = [('Manual underwriting', 'Excel and email drive placement and pricing.'),
             ('Siloed legacy suites', 'Policy, claims and finance never share one truth.'),
             ('Duplicate data entry', 'The same risk rekeyed across many systems.'),
             ('Slow placement & pricing', 'Time lost to spreadsheets and version chaos.'),
             ('No real-time visibility', 'Exposure and capacity are always yesterday’s.'),
             ('Fragmented reporting', 'Every return stitched together by hand.'),
             ('Regulatory complexity', 'Solvency, IFRS and audit run offline.'),
             ('No embedded assistance', 'No decision support where underwriters work.')]
    for i, (h, b) in enumerate(items):
        col = i % 4; row = i // 4
        x = 0.9 + col*3.05; y = 1.9 + row*2.35
        rect(s, x, y, 2.85, 2.05, fill=BG, line=LINE, radius=0.07)
        icon_tile(s, x+0.28, y+0.28, '!', AMBER, size=0.5, gsize=18)
        text(s, x+0.28, y+0.9, 2.4, 0.4, [[(h, 13, INK, True)]])
        text(s, x+0.28, y+1.3, 2.45, 0.7, [[(b, 10.5, SLATE, False)]], line_spacing=1.12)
    page_no(s, pn())

# ============================================================== 4. PRODUCT MAP (full IA)
def product_map():
    s = slide(BG); accent_bar(s); kicker(s, 'Product Map'); title(s, 'Every module, one connected suite', size=27)
    groups = [
        ('Overview', ['Dashboard','Executive','Intelligence','AI Insights','Search','Mobile'], BLUE),
        ('Underwriting', ['Underwriting Workspace','Treaty','Facultative','Placement','Pricing','Capacity & Exposure','Territory','Retrocession','Adjustments'], INDIGO),
        ('Distribution', ['Parties','Clients','Brokers','Cedents','CRM'], GREEN),
        ('Operations', ['Claims','Bordereaux','Recoveries','Operations Center','Workflow Center','Audit Log'], AMBER),
        ('Finance', ['Accounting','Statements','Finance','Treasury','Period Close','Procurement'], BLUE),
        ('Analytics & Compliance', ['Reports','Scheduled Reports','Analytics','Risk & Capital','Regulatory','Compliance','Returns'], INDIGO),
        ('HRMS', ['Attendance','People','Payroll','Performance','Assets','Org Structure'], GREEN),
        ('Master Data', ['Products','Reference Data','Code Lists'], AMBER),
        ('Documents & Knowledge', ['Documents','Templates','Knowledge Base'], BLUE),
        ('Integration & Automation', ['Integration Hub','Messaging','Automation Studio','Portal'], INDIGO),
        ('Administration', ['Admin','Legal Entities','Ops Console','Delegation','Security','Security Ops','Field Security','Retention','Cost Mgmt','Features'], GREEN),
        ('Ask RIOS Assistant', ['Copilot','NL Search','Recommendations'], AMBER)]
    for i, (h, items, c) in enumerate(groups):
        col = i % 4; row = i // 4
        x = 0.9 + col*3.05; y = 1.75 + row*1.75
        rect(s, x, y, 2.85, 1.58, fill=WHITE, line=LINE, radius=0.07)
        rect(s, x, y, 2.85, 0.1, fill=c, rounded=False)
        text(s, x+0.22, y+0.17, 2.5, 0.35, [[(h, 12, INK, True)]])
        text(s, x+0.22, y+0.56, 2.5, 1.0, [[(' · '.join(items), 8.3, SLATE, False)]], line_spacing=1.12)
    page_no(s, pn())

# ============================================================== 5. ARCHITECTURE
def architecture():
    s = slide(WHITE); accent_bar(s, color=INDIGO); kicker(s, 'System Architecture', color=INDIGO)
    title(s, 'A modern, layered enterprise architecture')
    layers = [('Experience','Web · Mobile · Portals · RIOS Assistant', BLUE),
              ('Business Modules','Underwriting · Distribution · Operations · Finance · HRMS · Analytics', INDIGO),
              ('Platform Services','Workflow Engine · Rules · Notifications · Audit · Search · AI', GREEN),
              ('Data & Integration','PostgreSQL (Row-Level Security) · Event Bus · APIs · ERP / Email / DMS', AMBER)]
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
    rect(s, 10.2, 2.0, 2.5, 4.35, fill=INK, radius=0.06)
    text(s, 10.45, 2.25, 2.1, 0.4, [[('CLOUD-NATIVE', 11, RGBColor(0x93,0xC5,0xFD), True)]])
    for i, t in enumerate(['Multi-tenant + RLS','Zero-trust security','Hash-chained audit','Integer-money ledger','Horizontal scale','CI/CD + observability']):
        text(s, 10.45, 2.75+i*0.58, 2.1, 0.4, [[('•  '+t, 11, WHITE, False)]])
    page_no(s, pn())

# ============================================================== 6. SECURITY
def security():
    s = slide(BG); accent_bar(s); kicker(s, 'Security & Trust'); title(s, 'Secure and auditable by design')
    items = [('Row-Level Security','Postgres RLS isolates every tenant — fail-closed.'),
             ('RBAC + ABAC','Role and attribute-based, field-level access control.'),
             ('SSO · SAML · MFA','Identity-provider ready with a TOTP second factor.'),
             ('Encryption','In transit and at rest; secrets kept out of code.'),
             ('Tamper-evident audit','Hash-chained, append-only audit trail on mutations.'),
             ('Least privilege','Owner vs application DB roles; no back doors.'),
             ('Guardrailed AI','The assistant confirms and re-checks permissions before acting.'),
             ('Control framework','Designed around GDPR / ISO 27001 / SOC 2 principles.')]
    for i, (h, b) in enumerate(items):
        col = i % 4; row = i // 4
        x = 0.9 + col*3.05; y = 1.95 + row*2.35
        rect(s, x, y, 2.85, 2.05, fill=WHITE, line=LINE, radius=0.07)
        icon_tile(s, x+0.28, y+0.26, '✓', GREEN, size=0.5, gsize=18)
        text(s, x+0.28, y+0.88, 2.4, 0.4, [[(h, 12.5, INK, True)]])
        text(s, x+0.28, y+1.28, 2.45, 0.7, [[(b, 10.3, SLATE, False)]], line_spacing=1.12)
    page_no(s, pn())

# ============================================================== SECTION DIVIDER
def section(num, ttl, sub, color=BLUE):
    s = slide(INK)
    accent_bar(s, 0, 0, 0.16, 7.5, color)
    text(s, 0.9, 2.5, 2, 1.2, [[(num, 60, _mix(color, INK, 0.9), True)]])
    text(s, 0.9, 3.55, 11.5, 1.0, [[(ttl, 33, WHITE, True)]])
    rect(s, 0.95, 4.4, 0.8, 0.05, fill=color, rounded=False)
    text(s, 0.95, 4.55, 10.5, 0.8, [[(sub, 14, RGBColor(0xC7,0xD2,0xFE), False)]], line_spacing=1.2)
    return s

# ============================================================== MODULE SLIDE (workhorse)
def module_slide(kick, ttl, shot, purpose, features, inside, ai, addr, color=BLUE):
    s = slide(WHITE); accent_bar(s, color=color); kicker(s, kick, color=color)
    title(s, ttl, size=23)
    text(s, 0.9, 1.5, 5.5, 1.0, [[(purpose, 11.5, SLATE, False)]], line_spacing=1.2)
    browser_frame(s, shot, 6.55, 1.5, 6.05, addr=addr)
    # capabilities
    text(s, 0.9, 2.72, 5.5, 0.3, [[('KEY CAPABILITIES', 10.5, color, True)]])
    bullets(s, 0.9, 3.06, 5.6, 1.9, features, size=11, marker_color=color, gap=4)
    # what's inside
    text(s, 0.9, 4.92, 5.5, 0.3, [[('WHAT’S INSIDE', 10.5, INK, True)]])
    chip_flow(s, 0.9, 5.26, 5.55, inside, color)
    # AI strip under screenshot
    rect(s, 6.55, 5.98, 6.05, 0.92, fill=_mix(INDIGO, WHITE, 0.08), radius=0.08)
    text(s, 6.8, 6.08, 1.2, 0.3, [[('AI  ✦', 12, INDIGO, True)]])
    text(s, 6.8, 6.4, 5.6, 0.45, [[(ai, 10, SLATE, False)]], line_spacing=1.05)
    page_no(s, pn())

# ============================================================== ASSISTANT
def assistant():
    s = slide(WHITE); accent_bar(s, color=INDIGO); kicker(s, 'RIOS Assistant', color=INDIGO)
    title(s, 'Ask RIOS — the guardrailed AI copilot', size=24)
    text(s, 0.9, 1.55, 5.5, 1.3, [[('A grounded assistant across the whole suite. Ask in natural language and get explainable answers with sources. The assistant can prepare an action, but it always re-checks permissions and confirms before it changes anything — and the platform works fully with AI switched off.', 11.5, SLATE, False)]], line_spacing=1.22)
    browser_frame(s, 'ai-insights.png', 6.55, 1.5, 6.05, addr='app.rios.cloud/ai-insights')
    pts = ['Natural-language questions across every module',
           'Explainable answers grounded in your own data',
           'Prepares actions, then confirms before committing',
           'Re-checks permissions — no backdoor, no black box',
           'Per-domain lenses: underwriting, claims, finance, exposure']
    text(s, 0.9, 3.05, 5.5, 0.3, [[('HOW IT WORKS', 10.5, INDIGO, True)]])
    bullets(s, 0.9, 3.4, 5.6, 2.6, pts, size=11.5, marker_color=INDIGO, gap=6)
    rect(s, 6.55, 5.98, 6.05, 0.92, fill=_mix(GREEN, WHITE, 0.08), radius=0.08)
    text(s, 6.8, 6.1, 5.6, 0.7, [[('Guardrail: every mutating action is confirmed and permission-checked — the assistant is a copilot, never an autopilot.', 10.5, SLATE, False)]], line_spacing=1.08)
    page_no(s, pn())

# ============================================================== PRODUCT LIFECYCLE
def lifecycle():
    s = slide(BG); accent_bar(s, color=GREEN); kicker(s, 'Product Lifecycle', color=GREEN)
    title(s, 'The reinsurance lifecycle, on one platform')
    steps = [('Place','Submission, quotes, placement tower', BLUE),
             ('Bind','Terms agreed; deposit premium booked', INDIGO),
             ('Account','Statements & balanced GL postings', AMBER),
             ('Reconcile','Technical → financial chain to zero', GREEN),
             ('Claims','FNOL, reserves, recoveries, cash calls', BLUE)]
    y = 2.6
    for i, (t, b, c) in enumerate(steps):
        x = 0.9 + i*2.42
        rect(s, x, y, 2.15, 2.0, fill=WHITE, line=LINE, radius=0.09)
        rect(s, x, y, 2.15, 0.12, fill=c, rounded=False)
        d = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x+0.24), Inches(y+0.34), Inches(0.5), Inches(0.5))
        _noshadow(d); d.fill.solid(); d.fill.fore_color.rgb = c; d.line.fill.background()
        text(s, x+0.24, y+0.34, 0.5, 0.5, [[(str(i+1), 16, WHITE, True)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        text(s, x+0.2, y+1.0, 1.85, 0.35, [[(t, 14, INK, True)]])
        text(s, x+0.2, y+1.35, 1.85, 0.6, [[(b, 9.5, SLATE, False)]], line_spacing=1.1)
        if i < len(steps)-1:
            arrow(s, x+2.16, y+0.85, 0.26, 0.28, MUTE)
    text(s, 0.9, 5.15, 11.5, 0.9, [[('This is the delivered vertical slice: a bound catastrophe XL treaty flows from placement through binding, statement, balanced general-ledger postings and reconciliation to zero, into claims — every step governed, audited and reconcilable.', 12.5, SLATE, False)]], line_spacing=1.25)
    page_no(s, pn())

# ============================================================== TECHNOLOGY
def technology():
    s = slide(WHITE); accent_bar(s, color=INDIGO); kicker(s, 'Technology', color=INDIGO)
    title(s, 'Built on a modern, proven stack')
    cols = [('Experience', ['React + Vite','Design-token system','Responsive & mobile','Accessible UI']),
            ('Services', ['Fastify (Node / TS)','Pure domain core','Workflow & rules engine','Event-driven']),
            ('Data', ['PostgreSQL 16','Row-Level Security','Integer-money ledger','Hash-chained audit']),
            ('Platform', ['Docker + Kubernetes','CI/CD pipeline','Observability & metrics','Horizontal scale'])]
    for i, (h, items) in enumerate(cols):
        x = 0.9 + i*3.05
        rect(s, x, 2.0, 2.85, 4.3, fill=BG, line=LINE, radius=0.06)
        rect(s, x, 2.0, 2.85, 0.7, fill=_mix([BLUE,INDIGO,GREEN,AMBER][i], WHITE, 0.12), radius=0.06)
        text(s, x+0.28, 2.16, 2.4, 0.4, [[(h, 15, INK, True)]])
        bullets(s, x+0.28, 2.95, 2.4, 3.2, items, size=11.5, marker_color=[BLUE,INDIGO,GREEN,AMBER][i], gap=8)
    text(s, 0.9, 6.55, 11.5, 0.4, [[('The reinsurance mathematics lives in a pure, unit-tested domain core — the server orchestrates and persists; it never re-implements the formulas.', 11, SLATE, False)]])
    page_no(s, pn())

# ============================================================== BUSINESS VALUE (qualitative)
def value():
    s = slide(BG); accent_bar(s, color=GREEN); kicker(s, 'Business Value', color=GREEN)
    title(s, 'Where RIOS creates value')
    cards = [('One source of truth','Place, bind, account, reconcile and claims on a single data model — no swivel-chair rekeying between systems.',BLUE,'◆'),
             ('Correct & reconcilable','Integer-accurate money and a technical → financial chain that reconciles to zero, by construction.',INDIGO,'∑'),
             ('Audited & inspection-ready','Hash-chained, append-only audit and a compliance surface built in — not bolted on.',GREEN,'✓'),
             ('Real-time exposure','Capacity utilisation and accumulation monitored live, with breach detection before you bind.',AMBER,'◎'),
             ('Configurable without code','Statuses, lines of business and rules are metadata — change the business vocabulary with no deployment.',BLUE,'⚙'),
             ('Less system sprawl','Reinsurance, finance, HR, documents and analytics in one platform instead of a dozen.',INDIGO,'▤')]
    for i, (h, b, c, g) in enumerate(cards):
        col = i % 3; row = i // 3
        x = 0.9 + col*4.05; y = 2.0 + row*2.4
        rect(s, x, y, 3.8, 2.2, fill=WHITE, line=LINE, radius=0.07)
        icon_tile(s, x+0.3, y+0.28, g, c, size=0.55, gsize=20)
        text(s, x+1.0, y+0.36, 2.7, 0.5, [[(h, 13.5, INK, True)]], anchor=MSO_ANCHOR.MIDDLE)
        text(s, x+0.3, y+1.1, 3.25, 1.0, [[(b, 10.5, SLATE, False)]], line_spacing=1.15)
    page_no(s, pn())

# ============================================================== APPROACH CONTRAST
def approach():
    s = slide(WHITE); accent_bar(s, color=INDIGO); kicker(s, 'The RIOS Approach', color=INDIGO)
    title(s, 'A different way to run reinsurance IT')
    rows = [('Systems','Many disconnected suites and spreadsheets','One unified platform and data model'),
            ('Configuration','Code changes and release cycles','Metadata-driven — no-code configuration'),
            ('Money','Floating point, reconciliation gaps','Integer minor units — reconciles to zero'),
            ('Audit','Bolt-on logs, editable history','Hash-chained, append-only, tamper-evident'),
            ('Security','Perimeter and coarse roles','Zero-trust, RLS, field-level RBAC/ABAC'),
            ('Assistance','None, or an ungoverned bolt-on','Grounded, guardrailed, works with AI off'),
            ('Deployment','On-prem monolith','Cloud-native, containerised, scalable')]
    x0, y0 = 0.9, 1.95
    wlab, wcol, hr = 2.3, 4.55, 0.62
    text(s, x0+0.1, y0, wlab, hr, [[('Dimension', 12, INK, True)]], anchor=MSO_ANCHOR.MIDDLE)
    rect(s, x0+wlab, y0, wcol-0.1, hr, fill=BG, radius=0.06)
    text(s, x0+wlab, y0, wcol-0.1, hr, [[('Traditional / legacy', 12, SLATE, True)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    rect(s, x0+wlab+wcol, y0, wcol-0.1, hr, fill=BLUE, radius=0.06)
    text(s, x0+wlab+wcol, y0, wcol-0.1, hr, [[('RIOS', 12, WHITE, True)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    for i, (lab, a, b) in enumerate(rows):
        ry = y0 + hr + 0.06 + i*0.63
        if i % 2 == 0:
            rect(s, x0, ry, wlab+2*wcol-0.1, 0.6, fill=BG, line=None, radius=0.03)
        text(s, x0+0.1, ry, wlab, 0.6, [[(lab, 11, INK, True)]], anchor=MSO_ANCHOR.MIDDLE)
        text(s, x0+wlab+0.15, ry, wcol-0.3, 0.6, [[(a, 10.3, SLATE, False)]], anchor=MSO_ANCHOR.MIDDLE, line_spacing=1.05)
        text(s, x0+wlab+wcol+0.15, ry, wcol-0.3, 0.6, [[(b, 10.3, INK, True)]], anchor=MSO_ANCHOR.MIDDLE, line_spacing=1.05)
    page_no(s, pn())

# ============================================================== JOURNEY
def journey():
    s = slide(BG); accent_bar(s, color=AMBER); kicker(s, 'Adoption Journey', color=AMBER)
    title(s, 'A guided path from evaluation to go-live')
    steps = ['Discovery','Solution design','Configuration','Data migration','Training','Go-live','Support & roadmap']
    y = 3.4
    for i, t in enumerate(steps):
        x = 0.95 + i*1.72
        c = [BLUE,INDIGO,GREEN,AMBER][i%4]
        d = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(0.5), Inches(0.5))
        _noshadow(d); d.fill.solid(); d.fill.fore_color.rgb = c; d.line.fill.background()
        text(s, x-0.35, y-0.02, 1.2, 0.5, [[(str(i+1), 15, WHITE, True)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        text(s, x-0.55, y+0.62, 1.6, 0.7, [[(t, 11, INK, True)]], align=PP_ALIGN.CENTER, line_spacing=1.0)
        if i < len(steps)-1:
            rect(s, x+0.5, y+0.22, 1.22, 0.06, fill=LINE, rounded=False)
    text(s, 0.9, 5.4, 11.5, 0.6, [[('Phased configuration, data migration and role-based training — de-risking the move to a unified platform, with a continuous-improvement roadmap after go-live.', 12.5, SLATE, False)]], line_spacing=1.2)
    page_no(s, pn())

# ============================================================== ROADMAP
def roadmap():
    s = slide(INK); accent_bar(s, color=BLUE)
    text(s, 0.9, 0.7, 8, 0.4, [[('ROADMAP', 11, RGBColor(0x93,0xC5,0xFD), True)]])
    text(s, 0.9, 1.05, 11, 0.8, [[('From foundation to intelligent reinsurance', 28, WHITE, True)]])
    ph = [('Now','Foundation','Unified platform, core modules, audit & security — the delivered vertical slice.',BLUE),
          ('Next','Assisted','Copilots and grounded insights across underwriting, claims and finance.',INDIGO),
          ('Later','Predictive','Portfolio-level prediction and catastrophe & capital modelling.',GREEN),
          ('Future','Connected','Connector marketplace and partner ecosystem.',AMBER),
          ('Vision','Straight-through','Governed, largely straight-through reinsurance operations.',BLUE)]
    rect(s, 1.1, 3.35, 11.1, 0.05, fill=RGBColor(0x33,0x41,0x55), rounded=False)
    for i, (yr, h, b, c) in enumerate(ph):
        x = 1.1 + i*2.28
        d = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(3.2), Inches(0.34), Inches(0.34))
        _noshadow(d); d.fill.solid(); d.fill.fore_color.rgb = c; d.line.fill.background()
        text(s, x-0.4, 2.55, 1.2, 0.4, [[(yr, 15, WHITE, True)]], align=PP_ALIGN.CENTER)
        text(s, x-0.55, 3.75, 2.15, 0.5, [[(h, 13, c, True)]], line_spacing=1.0)
        text(s, x-0.55, 4.25, 2.15, 1.6, [[(b, 10.5, RGBColor(0xC7,0xD2,0xFE), False)]], line_spacing=1.15)
    text(s, 0.9, 6.5, 11.5, 0.4, [[('Roadmap shown by horizon, not committed dates — capability direction, honestly staged.', 10.5, MUTE, False)]])
    page_no(s, pn())

# ============================================================== THANK YOU
def thankyou():
    s = slide(INK); accent_bar(s, color=BLUE)
    m = s.shapes.add_shape(MSO_SHAPE.HEXAGON, Inches(0.9), Inches(0.85), Inches(0.58), Inches(0.58))
    _noshadow(m); m.fill.solid(); m.fill.fore_color.rgb = BLUE; m.line.fill.background()
    text(s, 1.6, 0.9, 4, 0.5, [[('RIOS', 22, WHITE, True)]])
    text(s, 0.9, 2.7, 8, 1.4, [[('Let’s modernise', 40, WHITE, True)], [('your reinsurance operations.', 40, RGBColor(0x93,0xC5,0xFD), True)]], line_spacing=1.02)
    text(s, 0.95, 4.7, 7, 0.6, [[('Request a live walkthrough and see the unified platform on your own book.', 14, RGBColor(0xC7,0xD2,0xFE), False)]])
    for i, (h, v) in enumerate([('Website','rios.cloud'),('Email','hello@rios.cloud'),('Demo','rios.cloud/demo')]):
        x = 0.95 + i*2.9
        rect(s, x, 5.7, 2.65, 0.95, fill=RGBColor(0x1E,0x29,0x3B), radius=0.1)
        text(s, x+0.25, 5.82, 2.3, 0.3, [[(h.upper(), 9, MUTE, True)]])
        text(s, x+0.25, 6.12, 2.3, 0.4, [[(v, 13, WHITE, True)]])
    browser_frame(s, 'dashboard.png', 9.4, 2.4, 3.4, addr='app.rios.cloud')

# ============================================================== MODULE CONTENT
# tuple: (section_key, kicker, title, screenshot, purpose, [capabilities], [inside], ai_line, addr, color)
MODULES = [
  ('OVERVIEW','Overview','Dashboards, Executive & Intelligence','executive.png',
   'The command center. Operational dashboards and executive-intelligence views aggregate live KPIs across every module — written premium, technical result, portfolio mix and pipeline — with drill-down to source, plus enterprise search and a mobile-ready experience.',
   ['Operational dashboard with live tiles and alerts','Executive-intelligence views for leadership personas',
    'Premium, technical-result and portfolio-mix trends','Enterprise search across the whole suite'],
   ['Dashboard','Executive','Intelligence','AI Insights','Search','Mobile'],
   'AI Insights surfaces grounded, explainable observations per domain — each with a recommended action, and fully functional with AI disabled.',
   'app.rios.cloud/executive', BLUE),

  ('UNDERWRITING','Underwriting','Underwriting Workspace','underwriting.png',
   'The underwriting desk. A submission workbench triages risks, applies risk scoring and drives referrals and approvals through a guardrailed stage machine — with collaboration, tasks and audit on every action.',
   ['Submission triage, risk scoring and pipeline','Referral routing and an approval matrix',
    'Stage machine with guardrailed transitions','Tasks, collaboration and a full audit trail'],
   ['Submission Workbench','Referrals & Approvals','Analytics','Placement'],
   'Risk-scoring and pricing signals assist the underwriter; the system prepares actions and confirms before it commits.',
   'app.rios.cloud/underwriting', INDIGO),

  ('UNDERWRITING','Treaty','Treaty Workspace','treaty.png',
   'The complete treaty lifecycle in one cockpit: register the treaty, build a priced layer tower, manage versions, clauses and wording, the tax schedule and endorsements, and view the technical account over an audit-stitched timeline.',
   ['Priced layer tower — rate-on-line, reinstatements','Immutable versions and endorsements',
    'Special clauses, wording and tax schedule','Technical account that reconciles to zero'],
   ['Treaty Register','Layer Tower','Clauses & Wording','Endorsements','Technical Account'],
   'Layer-pricing analytics and clause suggestions support the drafter; nothing posts without confirmation.',
   'app.rios.cloud/w/treaty', INDIGO),

  ('UNDERWRITING','Facultative','Facultative Workspace','facultative.png',
   'An enterprise facultative desk. Capture and compare market quotes, build a signed-down placement tower with lead, follow, coinsurance and retro lines, and attach engineering and inspection reports.',
   ['Market quotes with best-quote comparison','Signed-down placement and coinsurance lines',
    'Engineering and inspection report capture','Placement timeline and completeness tracking'],
   ['Quotes','Placement Tower','Coinsurance','Engineering Reports'],
   'Best-quote selection and placement-gap detection help complete the order faster.',
   'app.rios.cloud/w/facultative', INDIGO),

  ('UNDERWRITING','Pricing · Placement · Retro','Pricing, Placement, Retrocession & Adjustments','pricing.png',
   'Actuarial pricing scenarios, placement management, outwards retrocession and treaty adjustments — with the gross / ceded / net position always reconciled and linked to recoveries.',
   ['Burning-cost, exposure and experience pricing','Placement lines and signed-down orders',
    'Outwards retrocession and recovery linkage','Adjustments: profit commission, sliding scale'],
   ['Pricing','Placement','Retrocession','Adjustments'],
   'Scenario comparison and rate signals assist pricing decisions; the net position updates as terms change.',
   'app.rios.cloud/pricing', INDIGO),

  ('UNDERWRITING','Capacity & Exposure','Capacity & Exposure','capacity-exposure.png',
   'Real-time capacity utilisation and exposure accumulation. Monitor limits with red-amber-green status, aggregate exposure by peak zone, and detect breaches before you bind.',
   ['Capacity utilisation with RAG status and alerts','Exposure aggregation and peak-zone concentration',
    'Accumulation heatmaps and forecasts','Breach detection prior to binding'],
   ['Capacity','Exposure Management','Accumulation'],
   'Capacity recommendations and exposure-anomaly flags give early warning of concentration risk.',
   'app.rios.cloud/w/capacity-exposure', INDIGO),

  ('UNDERWRITING','Territory','Territory Workspace','territory.png',
   'The geographic master. A country → state → city hierarchy joined to CRESTA, peril and risk zones, each linked to live exposure with total insured value, modelled PML and a blended risk score.',
   ['Country → state → city zone hierarchy','CRESTA / peril / postal / risk zones',
    'Insured value and modelled PML per territory','Blended risk score with severity bands'],
   ['Territory Hierarchy','Risk Zones','Exposure Link'],
   'Zone risk-scoring and accumulation insights highlight where capacity is tightening.',
   'app.rios.cloud/w/territory', INDIGO),

  ('DISTRIBUTION','Distribution','Parties, Brokers, Cedents & CRM','parties.png',
   'A single counterparty backbone. Parties, clients, brokers and cedents each carry a 360° profile — contracts, statements and claims — and a CRM manages pipeline, opportunities and communications.',
   ['Party 360: contracts, statements, claims','Broker and cedent profiles and tiers',
    'CRM pipeline, opportunities and activities','Contact directory and communication log'],
   ['Parties','Clients','Brokers','Cedents','CRM'],
   'Relationship insights and next-best-action suggestions surface where to focus.',
   'app.rios.cloud/parties', GREEN),

  ('OPERATIONS','Claims','Claims, Bordereaux & Recoveries','claims.png',
   'The claims lifecycle end to end — first notification to settlement — with bordereaux ingestion, reserves and recoveries, all connected to treaties, finance and the audit log.',
   ['Claim lifecycle with reserves and payments','Bordereaux ingestion and reconciliation',
    'Recovery and cash-call tracking','Every movement audited and reconcilable'],
   ['Claims','Bordereaux','Recoveries'],
   'Claims triage and leakage detection assist adjusters without overriding controls.',
   'app.rios.cloud/claims', AMBER),

  ('OPERATIONS','Operations & Workflow','Operations Center, Workflow & Audit','workflow-engine.png',
   'The operational control tower. Live workflow instances, SLA-scored tasks, an escalation queue and an approval matrix — over a tamper-evident, hash-chained audit trail.',
   ['Operations center with live work queues','SLA scoring with tiered escalation',
    'Approval matrix and delegation','Hash-chained, append-only audit log'],
   ['Operations Center','Workflow Center','Audit Log'],
   'SLA-breach prediction and bottleneck detection keep operations flowing.',
   'app.rios.cloud/workflow-engine', AMBER),

  ('FINANCE','Technical & General Accounting','Technical & General Accounting','accounting.png',
   'A complete accounting back office. Reconcilable financial events post balanced general-ledger entries; technical accounts and statements of account tie premium, commission and claims to the ledger, and each period is closed under control.',
   ['Balanced GL postings from financial events','Technical accounts and statements of account',
    'Period close with controls','Procurement and payables'],
   ['Accounting','Statements','Period Close','Procurement'],
   'Cash-flow forecasting and posting-anomaly detection support the finance team.',
   'app.rios.cloud/accounting', BLUE),

  ('FINANCE','Treasury & Investment','Treasury & Investment','finance.png',
   'Treasury and investment management. Track cash and bank positions, payments and settlements, and the investment portfolio — with the finance workspace giving a consolidated view of the book.',
   ['Cash, bank and settlement controls','Investment portfolio and positions',
    'Consolidated finance workspace','Integer-accurate money — no floating point'],
   ['Finance','Treasury','Investments'],
   'Liquidity and anomaly signals assist treasury; money is stored in integer minor units for exactness.',
   'app.rios.cloud/finance', BLUE),

  ('ANALYTICS','Reporting & Analytics','Complete Reporting & Analytics','reports.png',
   'Reporting across the whole suite. Build and schedule reports in PDF, Excel and CSV, and explore portfolio analytics with pivots, trends and forecasts — always with drill-down to source.',
   ['Report library with multi-format export','Scheduled, recurring report delivery',
    'Portfolio analytics: pivots and trends','Drill-down from summary to source'],
   ['Reports','Scheduled Reports','Analytics'],
   'Report summarisation turns dense output into a readable narrative.',
   'app.rios.cloud/reports', INDIGO),

  ('ANALYTICS','Risk & Capital','Risk & Capital','risk-capital.png',
   'Risk and capital management. Catastrophe metrics such as average annual loss and PML, risk-appetite monitoring, capital and solvency views, and reserving and loss-development analytics.',
   ['Catastrophe metrics — AAL and PML','Risk appetite and capital adequacy',
    'Solvency and capital views','Reserving and loss-development analytics'],
   ['Risk & Capital','Solvency','Reserving'],
   'Scenario analysis and capital-optimisation signals inform portfolio steering.',
   'app.rios.cloud/risk-capital', INDIGO),

  ('ANALYTICS','Regulatory & Compliance','Regulatory, Compliance & Returns','compliance.png',
   'A single assurance surface. An audit dashboard verifies chain integrity; approvals, user-activity and data-access logs, a compliance calendar and regulatory returns keep the reinsurer inspection-ready.',
   ['Audit dashboard and chain-integrity check','Approvals, activity and data-access logs',
    'Compliance calendar with due dates','Regulatory returns and filings'],
   ['Regulatory','Compliance','Returns','Audit'],
   'Regulatory-change alerts flag new obligations before deadlines.',
   'app.rios.cloud/compliance', INDIGO),

  ('HRMS','Human Resources','Human Resources — People, Payroll & Org','attendance.png',
   'An integrated HR back office, removing a separate system. Manage people, attendance and leave, payroll, performance, assets and the organisation structure — with reporting lines linked to system access.',
   ['People records, attendance and leave','Payroll and performance reviews',
    'Asset register and cost centres','Organisation structure and reporting lines'],
   ['Attendance','People','Payroll','Performance','Assets','Org Structure'],
   'Attendance-anomaly and workforce insights support HR operations.',
   'app.rios.cloud/attendance', GREEN),

  ('PLATFORM','Master Data','Master Data & Products','products.png',
   'The governed reference layer. Products and coverage definitions, lines of business, currencies, countries, clauses and business rules are configured as metadata — new values are added without a deployment.',
   ['Products and coverage definitions','Lines of business, currencies, countries',
    'Code-lists as metadata — no hard-coded enums','New values added without a release'],
   ['Products','Reference Data','Code Lists','Business Rules'],
   'Data-quality suggestions and rule validation keep the reference layer clean.',
   'app.rios.cloud/products', AMBER),

  ('PLATFORM','Documents','Documents & Knowledge','documents.png',
   'An enterprise document hub. A central repository with versioning and approval routing, template and clause libraries, retention policies and a searchable knowledge base.',
   ['Central repository with versioning','Templates and clause / wording libraries',
    'Approval routing and retention','Knowledge base and standard procedures'],
   ['Documents','Templates','Knowledge Base'],
   'Document extraction and summaries make content searchable and usable.',
   'app.rios.cloud/documents', AMBER),

  ('PLATFORM','Integration','Integration & Automation','integration-hub.png',
   'Open by design. REST and GraphQL APIs, connectors to ERP, policy and email systems, messaging over email and SMS, webhooks and an event bus, plus an automation studio and partner portal.',
   ['REST and GraphQL APIs, webhooks','Connectors and an event bus',
    'Messaging: email / SMS / channels','Automation studio, scheduler and portal'],
   ['Integration Hub','Messaging','Automation Studio','Portal'],
   'Auto-mapping and flow recommendations speed up new integrations.',
   'app.rios.cloud/integration-hub', AMBER),

  ('ADMIN','Administration','Administration & Security','admin.png',
   'Everything administrators need. Users, roles and permissions with role- and attribute-based access; legal entities and delegation of authority; security operations, field-level security, retention, cost management and feature flags.',
   ['RBAC + ABAC with field-level security','SSO / SAML / MFA and security operations',
    'Legal entities and delegation of authority','Retention, cost management and feature flags'],
   ['Admin','Legal Entities','Ops Console','Delegation','Security','Security Ops','Field Security','Retention','Cost Mgmt','Features'],
   'Access-anomaly detection and policy suggestions strengthen governance.',
   'app.rios.cloud/admin', BLUE),
]

sec = {
  'OVERVIEW':      ('01','Overview & Intelligence','Command center — dashboards, executive KPIs, AI insights, search and mobile.', BLUE),
  'UNDERWRITING':  ('02','Underwriting — the Reinsurance Core','Treaty & facultative, placement, pricing, capacity, exposure, territory, retrocession and adjustments.', INDIGO),
  'DISTRIBUTION':  ('03','Distribution','Parties, clients, brokers, cedents and the CRM.', GREEN),
  'OPERATIONS':    ('04','Operations','Claims, bordereaux, recoveries, the operations & workflow control tower and audit.', AMBER),
  'FINANCE':       ('05','Finance & Accounting','Technical and general accounting, statements, treasury and investment, period close and procurement.', BLUE),
  'ANALYTICS':     ('06','Analytics & Compliance','Complete reporting, analytics, risk & capital, regulatory returns and compliance.', INDIGO),
  'HRMS':          ('07','Human Resources','People, attendance, payroll, performance, assets and organisation structure.', GREEN),
  'PLATFORM':      ('08','Master Data, Documents & Integration','The governed reference layer, the document hub and open integration & automation.', AMBER),
  'ADMIN':         ('09','Administration & Security','Users and roles, legal entities, delegation, security operations, retention, cost and features.', BLUE),
}

# ============================================================== ASSEMBLE
cover()
about()
problems()
product_map()
architecture()
security()

seen = set()
for m in MODULES:
    key = m[0]
    if key not in seen:
        seen.add(key)
        num, ttl, sub, col = sec[key]
        section(num, ttl, sub, col)
    module_slide(*m[1:])

assistant()
lifecycle()
technology()
value()
approach()
journey()
roadmap()
thankyou()

out = os.path.join(BASE, 'RIOS_Enterprise_Presentation.pptx')
prs.save(out)
print('saved', out, '·', len(prs.slides._sldIdLst), 'slides')
