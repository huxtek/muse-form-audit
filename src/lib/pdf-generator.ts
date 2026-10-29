import jsPDF from 'jspdf';

import type { AnalyzedForm, FormCharacteristics } from '@/lib/scan-types';
import {
  aggregateCategories,
  averageScore,
  collectFindings,
  countSeverities
} from '@/lib/report-data';

/**
 * Every UTF-16 code unit outside the 7-bit ASCII range, i.e. the exact
 * complement of `[\x00-\x7F]`. Spelled as a positive range because the
 * negated form has to name the control character U+0000 literally. The two
 * patterns were checked to produce identical output for all 65,536 BMP code
 * units and for astral characters (whose surrogate halves both fall in this
 * range, so they are stripped either way). Control characters U+0000-U+001F
 * are deliberately NOT stripped here, matching the previous behaviour.
 */
const NON_ASCII_CODE_UNIT = /[\u0080-\uFFFF]/g;

/**
 * Punctuation the model actually writes, mapped to ASCII before the strip
 * above deletes it.
 *
 * Without this the removal is silent and lands mid-sentence: an em dash or a
 * curly quote simply vanishes, so "autocomplete="tel"" loses its quotes and a
 * dash-joined clause runs into the next word. The sample fixtures happen to
 * contain none of these, so the damage only shows on a real model run, which
 * is the worst way to find out.
 */
const ASCII_SUBSTITUTIONS: [RegExp, string][] = [
  [/[\u2010-\u2015]/g, '-'],
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/\u2026/g, '...'],
  [/[\u2022\u2023\u25E6\u2043]/g, '*'],
  [/\u00A0/g, ' '],
  [/\u00D7/g, 'x'],
  [/\u2192/g, '->'],
  [/\u2264/g, '<='],
  [/\u2265/g, '>='],
  [/\u00B7/g, '-']
];

/** Severity order and labels, matching the report page. */
const SEVERITY_TAGS: Record<string, string> = {
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW'
};

export interface ReportData {
  summary: {
    totalPages: number;
    totalForms: number;
    discoveredUrls: number;
    visitedUrls: number;
    coveragePercentage: number;
  };
  forms: AnalyzedForm[];
  aiSummary: string;
  scanMode: string;
  targetUrl: string;
  /** True when the report was built from the bundled mock fixtures. */
  isMockData?: boolean;
}

export class PDFGenerator {
  private doc: jsPDF;
  private currentY: number = 20;
  private pageHeight: number = 270; // Reduced from 280 to leave space for footer
  private margin: number = 20;
  private lineHeight: number = 6;
  private footerHeight: number = 20; // Space reserved for footer

  constructor() {
    this.doc = new jsPDF();
  }

  /**
   * Ordered like the report page: the score, where it came from, what to fix,
   * then the reference material. The score and the findings used to come
   * last or not at all.
   */
  generateReport(data: ReportData, jobId: string): void {
    this.addHeader(data);
    this.addExecutiveSummary(data);
    this.addScoreBreakdown(data);
    this.addFindings(data);
    this.addFormsOverview(data);
    this.addDetailedFormAnalysis(data);
    this.addAISummary(data);
    this.addFooter(jobId);
  }

  private addHeader(data: ReportData): void {
    // Title
    this.doc.setFontSize(24);
    this.doc.setFont('helvetica', 'bold');
    this.doc.text(this.cleanText('AI FORM AUDIT REPORT'), this.margin, this.currentY);
    this.currentY += 10;

    // Mock marker, directly under the title so it cannot be missed. Boxed
    // and coloured rather than set as plain text: a PDF gets forwarded,
    // printed and cropped, and a line of black body copy is the first thing
    // to be skimmed past -- leaving a document that reads as a real audit of
    // whatever site it names.
    if (data.isMockData) {
      const width = this.doc.internal.pageSize.getWidth() - this.margin * 2;

      this.doc.setFillColor(254, 243, 199);
      this.doc.setDrawColor(245, 158, 11);
      this.doc.rect(this.margin, this.currentY - 5, width, 11, 'FD');

      this.doc.setFontSize(11);
      this.doc.setFont('helvetica', 'bold');
      this.doc.setTextColor(146, 64, 14);
      this.doc.text(
        this.cleanText('SAMPLE DATA - describes a fictional site, not a real audit'),
        this.margin + 3,
        this.currentY + 2
      );

      this.doc.setTextColor(0);
      this.doc.setFont('helvetica', 'normal');
      this.currentY += 14;
    }

    this.currentY += 5;

    // Subtitle
    this.doc.setFontSize(14);
    this.doc.setFont('helvetica', 'normal');
    this.doc.text(this.cleanText(`Analysis of ${data.targetUrl}`), this.margin, this.currentY);
    this.currentY += 10;

    // Date and scan mode
    this.doc.setFontSize(10);
    this.doc.setTextColor(100);
    this.doc.text(this.cleanText(`Generated: ${new Date().toLocaleString()}`), this.margin, this.currentY);
    this.doc.text(this.cleanText(`Scan Mode: ${data.scanMode === 'single-page' ? 'Single Page Analysis' : 'Full Website Crawl'}`), 120, this.currentY);
    this.currentY += 15;

    // Separator line
    this.doc.setDrawColor(200);
    this.doc.line(this.margin, this.currentY, 190, this.currentY);
    this.currentY += 10;
  }

  private addExecutiveSummary(data: ReportData): void {
    this.addSectionHeader('EXECUTIVE SUMMARY');
    
    this.doc.setFontSize(10);
    this.doc.setTextColor(0);
    
    const summaryItems = [
      `Pages Analyzed: ${data.summary?.totalPages || 1}`,
      `Forms Found: ${data.summary?.totalForms || 0}`,
      `Site Coverage: ${data.summary?.coveragePercentage || 100}%`,
      `URLs Discovered: ${data.summary?.discoveredUrls || 1}`
    ];

    summaryItems.forEach(item => {
      this.doc.text(this.cleanText(`• ${item}`), this.margin + 5, this.currentY);
      this.currentY += this.lineHeight;
    });

    this.currentY += 5;
  }

  /**
   * The headline score and the eight categories that produced it.
   *
   * Reads the same `averageScore` and `aggregateCategories` the report page
   * uses, so the two cannot drift. The PDF previously stated no overall score
   * anywhere and no breakdown at all, while computing a separate figure of
   * its own further down.
   */
  private addScoreBreakdown(data: ReportData): void {
    const forms = data.forms ?? [];
    const score = averageScore(forms);
    const categories = aggregateCategories(forms);

    if (score === null && categories.length === 0) {
      return;
    }

    this.addSectionHeader('AI COMPATIBILITY SCORE');

    if (score !== null) {
      this.doc.setFontSize(22);
      this.doc.setFont('helvetica', 'bold');
      this.doc.setTextColor(0);
      this.doc.text(this.cleanText(`${score}/100`), this.margin, this.currentY);

      this.doc.setFontSize(10);
      this.doc.setFont('helvetica', 'normal');
      this.doc.setTextColor(100);
      this.doc.text(
        this.cleanText(
          forms.length === 1 ? 'across 1 form' : `averaged across ${forms.length} forms`
        ),
        this.margin + 35,
        this.currentY
      );
      this.doc.setTextColor(0);
      this.currentY += 12;
    }

    if (categories.length > 0) {
      this.doc.setFontSize(10);
      this.doc.setFont('helvetica', 'bold');
      this.doc.text(this.cleanText('Where the points went (biggest losses first):'), this.margin, this.currentY);
      this.currentY += 8;

      this.doc.setFont('helvetica', 'normal');

      categories.forEach((category) => {
        this.checkPageBreak(this.lineHeight + 1);

        const bar = this.buildBar(category.score, category.maxScore);

        this.doc.text(this.cleanText(category.label), this.margin + 5, this.currentY);
        this.doc.setFont('courier', 'normal');
        this.doc.text(this.cleanText(bar), this.margin + 50, this.currentY);
        this.doc.setFont('helvetica', 'normal');
        this.doc.text(
          this.cleanText(`${category.score}/${category.maxScore}`),
          this.margin + 125,
          this.currentY
        );

        this.currentY += this.lineHeight;
      });

      this.currentY += 5;
    }
  }

  /**
   * Every finding, flattened across forms, worst first.
   *
   * Same `collectFindings` the report page calls, so the document lists the
   * same items in the same order. The PDF carried none of these: it had only
   * the per-form `issues` and `recommendations` strings, which left all the
   * severity-rated, control-level findings out of the one artefact anyone
   * actually sends to a colleague.
   */
  private addFindings(data: ReportData): void {
    const findings = collectFindings(data.forms ?? []);
    const counts = countSeverities(findings);

    if (counts.total === 0) {
      return;
    }

    this.addSectionHeader(`FINDINGS (${counts.total})`);

    this.doc.setFontSize(10);
    this.doc.setFont('helvetica', 'normal');
    this.doc.setTextColor(100);
    this.doc.text(
      this.cleanText(`${counts.high} high, ${counts.medium} medium, ${counts.low} low`),
      this.margin,
      this.currentY
    );
    this.doc.setTextColor(0);
    this.currentY += 9;

    findings.forEach((finding) => {
      const tag = SEVERITY_TAGS[finding.severity] ?? finding.severity.toUpperCase();
      const where = [
        data.forms.length > 1 ? finding.formLabel : null,
        finding.field ?? 'whole form'
      ]
        .filter(Boolean)
        .join(' / ');

      const body = this.doc.splitTextToSize(this.cleanText(finding.issue), 160) as string[];

      // Keep the label and at least its first line on one page, so a finding
      // never arrives with its severity on the previous sheet.
      this.checkPageBreak(this.lineHeight * (body.length + 1) + 4);

      this.doc.setFont('helvetica', 'bold');
      this.doc.setFontSize(9);
      this.doc.text(this.cleanText(`[${tag}] ${where}`), this.margin, this.currentY);
      this.currentY += this.lineHeight;

      this.doc.setFont('helvetica', 'normal');
      this.doc.setFontSize(10);

      body.forEach((line) => {
        this.doc.text(line, this.margin + 5, this.currentY);
        this.currentY += this.lineHeight;
      });

      this.currentY += 2;
    });

    this.currentY += 5;
  }

  /**
   * A fixed-width bar, so the breakdown reads as a chart without needing
   * vector drawing interleaved with the text flow.
   */
  private buildBar(score: number, maxScore: number): string {
    const width = 20;
    const filled = maxScore > 0 ? Math.round((score / maxScore) * width) : 0;

    return `${'#'.repeat(filled)}${'.'.repeat(Math.max(0, width - filled))}`;
  }

  private addFormsOverview(data: ReportData): void {
    this.addSectionHeader('FORMS OVERVIEW');

    data.forms.forEach((form, index) => {
      this.checkPageBreak();
      
      // Form header
      this.doc.setFontSize(12);
      this.doc.setFont('helvetica', 'bold');
      this.doc.text(this.cleanText(`${index + 1}. ${form.formId}`), this.margin, this.currentY);
      this.currentY += 8;

      // Form details
      this.doc.setFontSize(10);
      this.doc.setFont('helvetica', 'normal');
      
      const formDetails = [
        // Guarded throughout. Every one of these fields is optional in
        // scan-types but declared required on this file's local ReportData,
        // which hid the gap at compile time -- so a single form missing its
        // `characteristics` threw and the download produced nothing at all
        // rather than a report with one thin section.
        `Type: ${this.getFormType(form.characteristics)}`,
        `Fields: ${(form.fields ?? []).filter(f => f.type !== 'hidden').length} visible, ${(form.fields ?? []).filter(f => f.type === 'hidden').length} hidden`,
        // One score, the one the analysis produced. There used to be two on
        // consecutive lines: this, and a local 100-minus-penalties figure
        // labelled "AI Compatibility Score" -- the same name the interface
        // gives the real one. They disagreed on every form in the sample,
        // and the newsletter form read 100/100 here while the report scored
        // it 78 and listed three findings against it.
        `AI Compatibility Score: ${form.accessibility?.score ?? 0}/100`,
        `Has CAPTCHA: ${form.characteristics?.hasCaptcha ? 'Yes [WARNING]' : 'No [OK]'}`,
        `Has File Upload: ${form.characteristics?.hasFileUpload ? 'Yes' : 'No'}`,
        `Has Validation: ${form.characteristics?.hasValidation ? 'Yes' : 'No'}`
      ];

      formDetails.forEach(detail => {
        this.doc.text(this.cleanText(`  • ${detail}`), this.margin + 5, this.currentY);
        this.currentY += this.lineHeight;
      });

      this.currentY += 5;
    });
  }

  private addDetailedFormAnalysis(data: ReportData): void {
    this.addSectionHeader('DETAILED FORM ANALYSIS');

    data.forms.forEach((form, index) => {
      this.checkPageBreak(40); // Need more space for detailed analysis
      
      // Form title
      this.doc.setFontSize(14);
      this.doc.setFont('helvetica', 'bold');
      this.doc.text(this.cleanText(`Form ${index + 1}: ${form.formId}`), this.margin, this.currentY);
      this.currentY += 10;

      // AI Compatibility Analysis
      this.doc.setFontSize(11);
      this.doc.setFont('helvetica', 'bold');
      this.doc.text(this.cleanText('AI AGENT COMPATIBILITY:'), this.margin + 5, this.currentY);
      this.currentY += 7;

      this.doc.setFontSize(10);
      this.doc.setFont('helvetica', 'normal');
      
      // Optional chaining throughout. These fields are declared required on
      // this file's local ReportData but are optional in scan-types, which
      // hid the mismatch at compile time: a real scan returning a form
      // without `aiAccessibility` threw here and took the whole download
      // with it.
      const ai = form.accessibility?.aiAccessibility;
      const aiCompatibility = [
        `Score: ${form.accessibility?.score ?? 0}/100`,
        `Has Name Attributes: ${ai?.hasNameAttributes ? 'Yes [OK]' : 'No [CRITICAL]'}`,
        `Has Labels: ${ai?.hasLabels ? 'Yes [OK]' : 'No [ISSUE]'}`,
        `CAPTCHA Present: ${ai?.hasCaptcha ? 'Yes [BLOCKER]' : 'No [OK]'}`,
        `File Upload: ${ai?.hasFileUpload ? 'Yes [COMPLEX]' : 'No [OK]'}`
      ];

      aiCompatibility.forEach(item => {
        this.checkPageBreak(this.lineHeight + 1);
        this.doc.text(this.cleanText(`    • ${item}`), this.margin + 10, this.currentY);
        this.currentY += this.lineHeight;
      });

      this.currentY += 3;

      // Field Analysis
      this.checkPageBreak(15);
      this.doc.setFontSize(11);
      this.doc.setFont('helvetica', 'bold');
      this.doc.text(this.cleanText('FIELD ANALYSIS:'), this.margin + 5, this.currentY);
      this.currentY += 7;

      const visibleFields = (form.fields ?? []).filter(f => f.type !== 'hidden' && f.type !== 'submit');
      
      if (visibleFields.length > 0) {
        visibleFields.forEach((field, fieldIndex) => {
          this.checkPageBreak(25); // Ensure space for field details
          
          this.doc.setFontSize(10);
          this.doc.setFont('helvetica', 'bold');
          this.doc.text(this.cleanText(`    Field ${fieldIndex + 1}: ${field.name || 'UNNAMED'}`), this.margin + 10, this.currentY);
          this.currentY += 6;

          this.doc.setFont('helvetica', 'normal');
          const fieldDetails = [
            `Type: ${field.type}`,
            `Label: ${field.label || 'MISSING [ISSUE]'}`,
            `Placeholder: ${field.placeholder || 'None'}`,
            `Required: ${field.required ? 'Yes' : 'No'}`,
            `AI Can Identify: ${field.name && (field.label || field.placeholder) ? 'Yes [OK]' : 'No [ISSUE]'}`,
            `AI Can Fill: ${field.name && field.type !== 'file' ? 'Yes [OK]' : 'No [ISSUE]'}`
          ];

          fieldDetails.forEach(detail => {
            this.checkPageBreak(this.lineHeight + 1);
            this.doc.text(this.cleanText(`      • ${detail}`), this.margin + 15, this.currentY);
            this.currentY += this.lineHeight;
          });

          this.currentY += 2;
        });
      } else {
        this.checkPageBreak(this.lineHeight + 1);
        this.doc.setFontSize(10);
        this.doc.text(this.cleanText('    No visible fields found'), this.margin + 10, this.currentY);
        this.currentY += this.lineHeight;
      }

      // Issues and Recommendations
      if ((form.accessibility?.issues?.length ?? 0) > 0) {
        this.currentY += 3;
        this.checkPageBreak(15);
        this.doc.setFontSize(11);
        this.doc.setFont('helvetica', 'bold');
        this.doc.text(this.cleanText('ISSUES FOUND:'), this.margin + 5, this.currentY);
        this.currentY += 7;

        this.doc.setFontSize(10);
        this.doc.setFont('helvetica', 'normal');
        (form.accessibility?.issues ?? []).forEach((issue: string) => {
          this.checkPageBreak(this.lineHeight + 1);
          this.doc.text(this.cleanText(`    • ${issue}`), this.margin + 10, this.currentY);
          this.currentY += this.lineHeight;
        });
      }

      if ((form.accessibility?.recommendations?.length ?? 0) > 0) {
        this.currentY += 3;
        this.checkPageBreak(15);
        this.doc.setFontSize(11);
        this.doc.setFont('helvetica', 'bold');
        this.doc.text(this.cleanText('RECOMMENDATIONS:'), this.margin + 5, this.currentY);
        this.currentY += 7;

        this.doc.setFontSize(10);
        this.doc.setFont('helvetica', 'normal');
        (form.accessibility?.recommendations ?? []).forEach((rec: string) => {
          this.checkPageBreak(this.lineHeight + 1);
          this.doc.text(this.cleanText(`    • ${rec}`), this.margin + 10, this.currentY);
          this.currentY += this.lineHeight;
        });
      }

      this.currentY += 10;
    });
  }

  private addAISummary(data: ReportData): void {
    this.addSectionHeader('AI ANALYSIS SUMMARY');
    
    // Parse markdown-like content and convert to plain text for PDF
    const cleanSummary = this.parseMarkdownToText(data.aiSummary);
    
    this.doc.setFontSize(10);
    this.doc.setFont('helvetica', 'normal');
    
    // Split text into lines and clean each line
    const lines = this.doc.splitTextToSize(cleanSummary, 170);
    
    lines.forEach((line: string) => {
      this.checkPageBreak(this.lineHeight + 2); // Add extra space buffer
      const cleanLine = this.cleanText(line);
      if (cleanLine.trim()) { // Only add non-empty lines
        this.doc.text(cleanLine, this.margin, this.currentY);
        this.currentY += this.lineHeight;
      }
    });
    
    // Add some space at the end to ensure footer doesn't overlap
    this.currentY += 10;
  }

  private addSectionHeader(title: string): void {
    this.checkPageBreak(20); // Ensure enough space for header and some content
    
    this.doc.setFontSize(16);
    this.doc.setFont('helvetica', 'bold');
    this.doc.setTextColor(0);
    this.doc.text(this.cleanText(title), this.margin, this.currentY);
    this.currentY += 12;
  }

  private addFooter(jobId: string): void {
    const pageCount = this.doc.getNumberOfPages();
    
    for (let i = 1; i <= pageCount; i++) {
      this.doc.setPage(i);
      this.doc.setFontSize(8);
      this.doc.setTextColor(150);
      this.doc.text(this.cleanText(`HuxTek Report - Job ID: ${jobId}`), this.margin, 290);
      this.doc.text(this.cleanText(`Page ${i} of ${pageCount}`), 160, 290);
    }
  }

  private checkPageBreak(requiredSpace: number = 10): void {
    // Check if we need more space than available (accounting for footer)
    if (this.currentY + requiredSpace > (this.pageHeight - this.footerHeight)) {
      this.doc.addPage();
      this.currentY = 20; // Reset to top margin
    }
  }

  private getFormType(characteristics?: FormCharacteristics): string {
    if (characteristics?.isContactForm) return 'Contact Form';
    if (characteristics?.isSearchForm) return 'Search Form';
    if (characteristics?.isLoginForm) return 'Login Form';
    return 'General Form';
  }

  private parseMarkdownToText(markdown: string): string {
    return markdown
      // Remove markdown headers
      .replace(/#{1,6}\s+/g, '')
      // Remove bold formatting
      .replace(/\*\*(.*?)\*\*/g, '$1')
      // Remove italic formatting  
      .replace(/\*(.*?)\*/g, '$1')
      // Remove code formatting
      .replace(/`(.*?)`/g, '$1')
      // Convert blockquotes to bullets
      .replace(/>\s*/g, '• ')
      // Remove ALL Unicode characters and emojis (comprehensive)
      .replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
      // Remove specific problematic characters
      .replace(NON_ASCII_CODE_UNIT, '') // Remove all non-ASCII characters
      // Clean up multiple spaces
      .replace(/\s+/g, ' ')
      // Remove extra line breaks
      .replace(/\n\s*\n/g, '\n')
      // Remove leading/trailing whitespace
      .trim();
  }

  // Add a method to clean any text before adding to PDF
  private cleanText(text: string): string {
    // Substitute before stripping, so recognisable punctuation survives as
    // its ASCII equivalent instead of disappearing from the middle of a
    // sentence. jsPDF's built-in fonts cannot encode anything above U+007F,
    // so whatever is left after this has to go.
    const substituted = ASCII_SUBSTITUTIONS.reduce(
      (result, [pattern, replacement]) => result.replace(pattern, replacement),
      text
    );

    return substituted
      // Remove non-ASCII characters
      .replace(NON_ASCII_CODE_UNIT, '')
      // Normalize spaces
      .replace(/\s+/g, ' ')
      // Trim whitespace
      .trim();
  }

  download(filename: string): void {
    this.doc.save(filename);
  }
}
