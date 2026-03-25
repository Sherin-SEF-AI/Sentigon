"""PDF Evidence Report Generator -- creates court-ready evidence packages."""

from __future__ import annotations

import hashlib
import io
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────
# Conditional reportlab import
# ──────────────────────────────────────────────────────────────────────

_HAS_REPORTLAB = False
try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import inch, mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.colors import HexColor
    from reportlab.platypus import (
        SimpleDocTemplate,
        Paragraph,
        Spacer,
        Table,
        TableStyle,
        PageBreak,
        HRFlowable,
    )
    from reportlab.lib.enums import TA_CENTER, TA_LEFT

    _HAS_REPORTLAB = True
    logger.info("pdf_report_generator: reportlab available")
except ImportError:
    logger.warning("pdf_report_generator: reportlab not installed — using text fallback")


# ──────────────────────────────────────────────────────────────────────
# Shared helpers
# ──────────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _data_hash(data: Dict[str, Any]) -> str:
    """SHA-256 hex digest of the JSON-serialised data payload."""
    raw = json.dumps(data, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _safe_str(value: Any, max_len: int = 500) -> str:
    """Convert any value to a truncated string safe for embedding in a PDF."""
    s = str(value) if value is not None else ""
    return s[:max_len]


# ──────────────────────────────────────────────────────────────────────
# ReportLab styles
# ──────────────────────────────────────────────────────────────────────

def _build_styles():
    """Create custom ParagraphStyles on top of the sample stylesheet."""
    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        name="CoverTitle",
        parent=styles["Title"],
        fontSize=28,
        leading=34,
        textColor=HexColor("#1a237e"),
        alignment=TA_CENTER,
        spaceAfter=12,
    ))
    styles.add(ParagraphStyle(
        name="CoverSubtitle",
        parent=styles["Normal"],
        fontSize=14,
        leading=18,
        textColor=HexColor("#455a64"),
        alignment=TA_CENTER,
        spaceAfter=6,
    ))
    styles.add(ParagraphStyle(
        name="SectionHeading",
        parent=styles["Heading2"],
        fontSize=16,
        leading=20,
        textColor=HexColor("#1a237e"),
        spaceBefore=18,
        spaceAfter=8,
    ))
    styles.add(ParagraphStyle(
        name="BodyText2",
        parent=styles["BodyText"],
        fontSize=10,
        leading=14,
        spaceAfter=6,
    ))
    styles.add(ParagraphStyle(
        name="FooterStyle",
        parent=styles["Normal"],
        fontSize=8,
        textColor=HexColor("#90a4ae"),
        alignment=TA_CENTER,
    ))
    styles.add(ParagraphStyle(
        name="BulletItem",
        parent=styles["BodyText"],
        fontSize=10,
        leading=14,
        leftIndent=20,
        bulletIndent=10,
        spaceAfter=4,
    ))

    return styles


def _table_style() -> "TableStyle":
    """Standard table style for evidence tables."""
    return TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HexColor("#1a237e")),
        ("TEXTCOLOR", (0, 0), (-1, 0), HexColor("#ffffff")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        ("TOPPADDING", (0, 0), (-1, 0), 8),
        ("BACKGROUND", (0, 1), (-1, -1), HexColor("#f5f5f5")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [HexColor("#ffffff"), HexColor("#f5f5f5")]),
        ("FONTSIZE", (0, 1), (-1, -1), 8),
        ("TOPPADDING", (0, 1), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
        ("GRID", (0, 0), (-1, -1), 0.5, HexColor("#bdbdbd")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ])


# ──────────────────────────────────────────────────────────────────────
# Footer callback
# ──────────────────────────────────────────────────────────────────────

def _footer_callback(canvas, doc):
    """Draw footer on each page: confidentiality notice + page number."""
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(HexColor("#90a4ae"))
    page_num = canvas.getPageNumber()
    footer_text = f"SENTINEL AI \u2014 CONFIDENTIAL  |  Page {page_num}"
    canvas.drawCentredString(A4[0] / 2, 15 * mm, footer_text)
    canvas.restoreState()


# ======================================================================
# Public API
# ======================================================================

async def generate_evidence_report(data: Dict[str, Any]) -> bytes:
    """Generate a PDF evidence report.  Returns PDF bytes.

    Falls back to a formatted plain-text report if reportlab is not installed.
    """
    try:
        if _HAS_REPORTLAB:
            return _build_evidence_pdf(data)
        return _build_evidence_text(data)
    except Exception as exc:
        logger.exception("pdf_report_generator.evidence_report_error: %s", exc)
        # Last-resort fallback
        return _build_evidence_text(data)


async def generate_investigation_report(data: Dict[str, Any]) -> bytes:
    """Generate a PDF investigation report.  Returns PDF bytes.

    Falls back to a formatted plain-text report if reportlab is not installed.
    """
    try:
        if _HAS_REPORTLAB:
            return _build_investigation_pdf(data)
        return _build_investigation_text(data)
    except Exception as exc:
        logger.exception("pdf_report_generator.investigation_report_error: %s", exc)
        return _build_investigation_text(data)


# ======================================================================
# ReportLab PDF builders
# ======================================================================

def _build_evidence_pdf(data: Dict[str, Any]) -> bytes:
    """Build the evidence report PDF using reportlab."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=25 * mm,
        bottomMargin=25 * mm,
    )
    styles = _build_styles()
    story: List = []

    case_id = data.get("case_id", data.get("incident_id", "N/A"))
    generated_at = _now_iso()

    # ── Cover page ────────────────────────────────────────────────────
    story.append(Spacer(1, 80))
    story.append(Paragraph("SENTINEL AI", styles["CoverTitle"]))
    story.append(Paragraph("Evidence Report", styles["CoverTitle"]))
    story.append(Spacer(1, 20))
    story.append(Paragraph(f"Case ID: {_safe_str(case_id)}", styles["CoverSubtitle"]))
    story.append(Paragraph(f"Generated: {generated_at}", styles["CoverSubtitle"]))
    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="80%", color=HexColor("#1a237e"), thickness=2))
    story.append(PageBreak())

    # ── Executive Summary ─────────────────────────────────────────────
    story.append(Paragraph("Executive Summary", styles["SectionHeading"]))
    narrative = data.get("narrative", "No narrative available.")
    story.append(Paragraph(_safe_str(narrative, 5000), styles["BodyText2"]))
    story.append(Spacer(1, 10))

    # ── Key Findings ──────────────────────────────────────────────────
    findings = data.get("key_findings", [])
    if findings:
        story.append(Paragraph("Key Findings", styles["SectionHeading"]))
        for i, finding in enumerate(findings, 1):
            story.append(Paragraph(
                f"<b>{i}.</b> {_safe_str(finding, 1000)}",
                styles["BulletItem"],
            ))
        story.append(Spacer(1, 10))

    # ── Evidence Timeline ─────────────────────────────────────────────
    timeline = data.get("timeline", [])
    if timeline:
        story.append(Paragraph("Evidence Timeline", styles["SectionHeading"]))
        table_data = [["Time", "Type", "Camera", "Description", "Confidence"]]
        for event in timeline[:100]:
            table_data.append([
                _safe_str(event.get("timestamp", event.get("time", "")), 25),
                _safe_str(event.get("type", ""), 20),
                _safe_str(event.get("camera_id", event.get("camera", "")), 15),
                _safe_str(event.get("description", ""), 80),
                _safe_str(event.get("confidence", ""), 10),
            ])
        col_widths = [70, 60, 55, 220, 50]
        tbl = Table(table_data, colWidths=col_widths, repeatRows=1)
        tbl.setStyle(_table_style())
        story.append(tbl)
        story.append(Spacer(1, 10))

    # ── Entity Summary ────────────────────────────────────────────────
    entities = data.get("entity_summary", [])
    if entities:
        story.append(Paragraph("Entity Summary", styles["SectionHeading"]))
        table_data = [["Entity ID", "Description", "First Seen", "Last Seen", "Cameras", "Risk"]]
        for ent in entities[:50]:
            table_data.append([
                _safe_str(ent.get("entity_id", ""), 15),
                _safe_str(ent.get("description", ""), 60),
                _safe_str(ent.get("first_seen", ""), 25),
                _safe_str(ent.get("last_seen", ""), 25),
                _safe_str(ent.get("cameras", ""), 30),
                _safe_str(ent.get("risk_level", ent.get("risk", "")), 10),
            ])
        col_widths = [55, 120, 70, 70, 80, 40]
        tbl = Table(table_data, colWidths=col_widths, repeatRows=1)
        tbl.setStyle(_table_style())
        story.append(tbl)
        story.append(Spacer(1, 10))

    # ── Risk Assessment ───────────────────────────────────────────────
    risk = data.get("risk_assessment", {})
    if risk:
        story.append(Paragraph("Risk Assessment", styles["SectionHeading"]))
        if isinstance(risk, dict):
            for key, value in risk.items():
                story.append(Paragraph(
                    f"<b>{key}:</b> {_safe_str(value, 500)}",
                    styles["BodyText2"],
                ))
        else:
            story.append(Paragraph(_safe_str(risk, 2000), styles["BodyText2"]))
        story.append(Spacer(1, 10))

    # ── Recommendations ───────────────────────────────────────────────
    recommendations = data.get("recommendations", [])
    if recommendations:
        story.append(Paragraph("Recommendations", styles["SectionHeading"]))
        for i, rec in enumerate(recommendations, 1):
            story.append(Paragraph(
                f"<b>{i}.</b> {_safe_str(rec, 1000)}",
                styles["BulletItem"],
            ))
        story.append(Spacer(1, 10))

    # ── Chain of Custody ──────────────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Chain of Custody", styles["SectionHeading"]))
    story.append(HRFlowable(width="100%", color=HexColor("#1a237e"), thickness=1))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        f"<b>Generated at:</b> {generated_at}", styles["BodyText2"],
    ))
    story.append(Paragraph(
        f"<b>Data payload SHA-256:</b> {_data_hash(data)}", styles["BodyText2"],
    ))
    story.append(Paragraph(
        f"<b>Case ID:</b> {_safe_str(case_id)}", styles["BodyText2"],
    ))
    story.append(Paragraph(
        "<b>Access log:</b> Report generated by SENTINEL AI automated system. "
        "No manual modifications applied.",
        styles["BodyText2"],
    ))

    # Build PDF
    doc.build(story, onFirstPage=_footer_callback, onLaterPages=_footer_callback)
    return buf.getvalue()


def _build_investigation_pdf(data: Dict[str, Any]) -> bytes:
    """Build the investigation report PDF using reportlab."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=25 * mm,
        bottomMargin=25 * mm,
    )
    styles = _build_styles()
    story: List = []

    generated_at = _now_iso()
    query = data.get("query", "N/A")

    # ── Cover page ────────────────────────────────────────────────────
    story.append(Spacer(1, 80))
    story.append(Paragraph("SENTINEL AI", styles["CoverTitle"]))
    story.append(Paragraph("Investigation Report", styles["CoverTitle"]))
    story.append(Spacer(1, 20))
    story.append(Paragraph(f"Query: {_safe_str(query, 200)}", styles["CoverSubtitle"]))
    story.append(Paragraph(f"Generated: {generated_at}", styles["CoverSubtitle"]))
    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="80%", color=HexColor("#1a237e"), thickness=2))
    story.append(PageBreak())

    # ── Query ─────────────────────────────────────────────────────────
    story.append(Paragraph("Investigation Query", styles["SectionHeading"]))
    story.append(Paragraph(_safe_str(query, 2000), styles["BodyText2"]))
    story.append(Spacer(1, 10))

    # ── Investigation Plan ────────────────────────────────────────────
    plan = data.get("investigation_plan", [])
    if plan:
        story.append(Paragraph("Investigation Plan", styles["SectionHeading"]))
        table_data = [["#", "Tool", "Reason"]]
        for i, step in enumerate(plan, 1):
            table_data.append([
                str(i),
                _safe_str(step.get("tool", ""), 30),
                _safe_str(step.get("reason", ""), 200),
            ])
        col_widths = [25, 90, 340]
        tbl = Table(table_data, colWidths=col_widths, repeatRows=1)
        tbl.setStyle(_table_style())
        story.append(tbl)
        story.append(Spacer(1, 10))

    # ── Steps Executed ────────────────────────────────────────────────
    steps = data.get("steps_completed", [])
    if steps:
        story.append(Paragraph("Steps Executed", styles["SectionHeading"]))
        for step in steps:
            step_num = step.get("step_number", "?")
            tool = step.get("tool", "unknown")
            status = step.get("status", "unknown")
            summary = step.get("result_summary", "")
            evidence = step.get("evidence_count", 0)

            story.append(Paragraph(
                f"<b>Step {step_num} \u2014 {tool}</b> [{status}]  "
                f"({evidence} evidence items)",
                styles["BodyText2"],
            ))
            if summary:
                story.append(Paragraph(
                    _safe_str(summary, 1000), styles["BulletItem"],
                ))
        story.append(Spacer(1, 10))

    # ── Final Report ──────────────────────────────────────────────────
    report = data.get("report", {})
    if report:
        narrative = report.get("narrative", "")
        if narrative:
            story.append(Paragraph("Analysis Narrative", styles["SectionHeading"]))
            story.append(Paragraph(_safe_str(narrative, 5000), styles["BodyText2"]))
            story.append(Spacer(1, 8))

        key_findings = report.get("key_findings", [])
        if key_findings:
            story.append(Paragraph("Key Findings", styles["SectionHeading"]))
            for i, finding in enumerate(key_findings, 1):
                story.append(Paragraph(
                    f"<b>{i}.</b> {_safe_str(finding, 1000)}",
                    styles["BulletItem"],
                ))
            story.append(Spacer(1, 8))

        risk = report.get("risk_assessment", "")
        if risk:
            story.append(Paragraph("Risk Assessment", styles["SectionHeading"]))
            story.append(Paragraph(_safe_str(risk, 2000), styles["BodyText2"]))
            story.append(Spacer(1, 8))

        recommendations = report.get("recommendations", [])
        if recommendations:
            story.append(Paragraph("Recommendations", styles["SectionHeading"]))
            for i, rec in enumerate(recommendations, 1):
                story.append(Paragraph(
                    f"<b>{i}.</b> {_safe_str(rec, 1000)}",
                    styles["BulletItem"],
                ))
            story.append(Spacer(1, 8))

    # ── Evidence Items ────────────────────────────────────────────────
    evidence_items = report.get("evidence_items", []) if report else data.get("evidence_items", [])
    if evidence_items:
        story.append(Paragraph("Evidence Items", styles["SectionHeading"]))
        table_data = [["Type", "Source", "Description", "Confidence"]]
        for item in evidence_items[:100]:
            table_data.append([
                _safe_str(item.get("type", ""), 20),
                _safe_str(item.get("source", ""), 25),
                _safe_str(item.get("description", ""), 150),
                _safe_str(item.get("confidence", ""), 10),
            ])
        col_widths = [65, 75, 275, 50]
        tbl = Table(table_data, colWidths=col_widths, repeatRows=1)
        tbl.setStyle(_table_style())
        story.append(tbl)
        story.append(Spacer(1, 10))

    # ── Chain of Custody ──────────────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Chain of Custody", styles["SectionHeading"]))
    story.append(HRFlowable(width="100%", color=HexColor("#1a237e"), thickness=1))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        f"<b>Generated at:</b> {generated_at}", styles["BodyText2"],
    ))
    story.append(Paragraph(
        f"<b>Data payload SHA-256:</b> {_data_hash(data)}", styles["BodyText2"],
    ))
    story.append(Paragraph(
        f"<b>Investigation query:</b> {_safe_str(query, 300)}", styles["BodyText2"],
    ))
    story.append(Paragraph(
        f"<b>Total evidence items:</b> {data.get('total_evidence_items', 0)}",
        styles["BodyText2"],
    ))
    story.append(Paragraph(
        "<b>Access log:</b> Report generated by SENTINEL AI automated investigation system. "
        "No manual modifications applied.",
        styles["BodyText2"],
    ))

    doc.build(story, onFirstPage=_footer_callback, onLaterPages=_footer_callback)
    return buf.getvalue()


# ======================================================================
# Plain-text fallback builders
# ======================================================================

_DIVIDER = "=" * 72
_SUB_DIVIDER = "-" * 72


def _build_evidence_text(data: Dict[str, Any]) -> bytes:
    """Generate a formatted plain-text evidence report as UTF-8 bytes."""
    lines: List[str] = []
    generated_at = _now_iso()
    case_id = data.get("case_id", data.get("incident_id", "N/A"))

    lines.append(_DIVIDER)
    lines.append("  SENTINEL AI -- Evidence Report")
    lines.append(_DIVIDER)
    lines.append(f"  Case ID:    {case_id}")
    lines.append(f"  Generated:  {generated_at}")
    lines.append(_DIVIDER)
    lines.append("")

    # Executive Summary
    lines.append("EXECUTIVE SUMMARY")
    lines.append(_SUB_DIVIDER)
    lines.append(str(data.get("narrative", "No narrative available.")))
    lines.append("")

    # Key Findings
    findings = data.get("key_findings", [])
    if findings:
        lines.append("KEY FINDINGS")
        lines.append(_SUB_DIVIDER)
        for i, f in enumerate(findings, 1):
            lines.append(f"  {i}. {f}")
        lines.append("")

    # Evidence Timeline
    timeline = data.get("timeline", [])
    if timeline:
        lines.append("EVIDENCE TIMELINE")
        lines.append(_SUB_DIVIDER)
        lines.append(f"  {'Time':<25} {'Type':<15} {'Camera':<15} {'Description'}")
        for event in timeline[:100]:
            lines.append(
                f"  {str(event.get('timestamp', event.get('time', ''))):<25} "
                f"{str(event.get('type', '')):<15} "
                f"{str(event.get('camera_id', event.get('camera', ''))):<15} "
                f"{str(event.get('description', ''))[:80]}"
            )
        lines.append("")

    # Entity Summary
    entities = data.get("entity_summary", [])
    if entities:
        lines.append("ENTITY SUMMARY")
        lines.append(_SUB_DIVIDER)
        for ent in entities[:50]:
            lines.append(
                f"  [{ent.get('entity_id', '?')}] {ent.get('description', '')} "
                f"| Risk: {ent.get('risk_level', ent.get('risk', 'N/A'))} "
                f"| Cameras: {ent.get('cameras', '')}"
            )
        lines.append("")

    # Risk Assessment
    risk = data.get("risk_assessment", {})
    if risk:
        lines.append("RISK ASSESSMENT")
        lines.append(_SUB_DIVIDER)
        if isinstance(risk, dict):
            for k, v in risk.items():
                lines.append(f"  {k}: {v}")
        else:
            lines.append(f"  {risk}")
        lines.append("")

    # Recommendations
    recommendations = data.get("recommendations", [])
    if recommendations:
        lines.append("RECOMMENDATIONS")
        lines.append(_SUB_DIVIDER)
        for i, rec in enumerate(recommendations, 1):
            lines.append(f"  {i}. {rec}")
        lines.append("")

    # Chain of Custody
    lines.append(_DIVIDER)
    lines.append("CHAIN OF CUSTODY")
    lines.append(_SUB_DIVIDER)
    lines.append(f"  Generated at:          {generated_at}")
    lines.append(f"  Data payload SHA-256:  {_data_hash(data)}")
    lines.append(f"  Case ID:               {case_id}")
    lines.append("  Access log:            Report generated by SENTINEL AI automated system.")
    lines.append(_DIVIDER)

    return "\n".join(lines).encode("utf-8")


def _build_investigation_text(data: Dict[str, Any]) -> bytes:
    """Generate a formatted plain-text investigation report as UTF-8 bytes."""
    lines: List[str] = []
    generated_at = _now_iso()
    query = data.get("query", "N/A")

    lines.append(_DIVIDER)
    lines.append("  SENTINEL AI -- Investigation Report")
    lines.append(_DIVIDER)
    lines.append(f"  Query:      {query}")
    lines.append(f"  Generated:  {generated_at}")
    lines.append(_DIVIDER)
    lines.append("")

    # Investigation Plan
    plan = data.get("investigation_plan", [])
    if plan:
        lines.append("INVESTIGATION PLAN")
        lines.append(_SUB_DIVIDER)
        for i, step in enumerate(plan, 1):
            lines.append(f"  {i}. [{step.get('tool', '?')}] {step.get('reason', '')}")
        lines.append("")

    # Steps Executed
    steps = data.get("steps_completed", [])
    if steps:
        lines.append("STEPS EXECUTED")
        lines.append(_SUB_DIVIDER)
        for step in steps:
            lines.append(
                f"  Step {step.get('step_number', '?')} -- {step.get('tool', '?')} "
                f"[{step.get('status', '?')}] "
                f"({step.get('evidence_count', 0)} evidence items)"
            )
            summary = step.get("result_summary", "")
            if summary:
                lines.append(f"    {summary}")
        lines.append("")

    # Final Report
    report = data.get("report", {})
    if report:
        narrative = report.get("narrative", "")
        if narrative:
            lines.append("ANALYSIS NARRATIVE")
            lines.append(_SUB_DIVIDER)
            lines.append(str(narrative))
            lines.append("")

        key_findings = report.get("key_findings", [])
        if key_findings:
            lines.append("KEY FINDINGS")
            lines.append(_SUB_DIVIDER)
            for i, f in enumerate(key_findings, 1):
                lines.append(f"  {i}. {f}")
            lines.append("")

        risk = report.get("risk_assessment", "")
        if risk:
            lines.append("RISK ASSESSMENT")
            lines.append(_SUB_DIVIDER)
            lines.append(f"  {risk}")
            lines.append("")

        recommendations = report.get("recommendations", [])
        if recommendations:
            lines.append("RECOMMENDATIONS")
            lines.append(_SUB_DIVIDER)
            for i, rec in enumerate(recommendations, 1):
                lines.append(f"  {i}. {rec}")
            lines.append("")

    # Evidence Items
    evidence_items = report.get("evidence_items", []) if report else data.get("evidence_items", [])
    if evidence_items:
        lines.append("EVIDENCE ITEMS")
        lines.append(_SUB_DIVIDER)
        lines.append(f"  {'Type':<20} {'Source':<20} {'Description'}")
        for item in evidence_items[:100]:
            lines.append(
                f"  {str(item.get('type', '')):<20} "
                f"{str(item.get('source', '')):<20} "
                f"{str(item.get('description', ''))[:80]}"
            )
        lines.append("")

    # Chain of Custody
    lines.append(_DIVIDER)
    lines.append("CHAIN OF CUSTODY")
    lines.append(_SUB_DIVIDER)
    lines.append(f"  Generated at:          {generated_at}")
    lines.append(f"  Data payload SHA-256:  {_data_hash(data)}")
    lines.append(f"  Investigation query:   {query}")
    lines.append(f"  Total evidence items:  {data.get('total_evidence_items', 0)}")
    lines.append("  Access log:            Report generated by SENTINEL AI automated investigation system.")
    lines.append(_DIVIDER)

    return "\n".join(lines).encode("utf-8")
