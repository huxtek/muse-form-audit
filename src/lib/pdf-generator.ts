import jsPDF from 'jspdf';

import type { AnalyzedForm, FormCharacteristics } from '@/lib/scan-types';

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

  generateReport(data: ReportData, jobId: string): void {
    this.addHeader(data);
    this.addExecutiveSummary(data);
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
        `Type: ${this.getFormType(form.characteristics)}`,
        `Fields: ${form.fields.filter(f => f.type !== 'hidden').length} visible, ${form.fields.filter(f => f.type === 'hidden').length} hidden`,
        `AI Compatibility Score: ${this.calculateAIScore(form)}/100`,
        `Accessibility Score: ${form.accessibility.score}/100`,
        `Has CAPTCHA: ${form.characteristics.hasCaptcha ? 'Yes [WARNING]' : 'No [OK]'}`,
        `Has File Upload: ${form.characteristics.hasFileUpload ? 'Yes' : 'No'}`,
        `Has Validation: ${form.characteristics.hasValidation ? 'Yes' : 'No'}`
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
      
      const aiCompatibility = [
        `Score: ${this.calculateAIScore(form)}/100`,
        `Has Name Attributes: ${form.accessibility.aiAccessibility.hasNameAttributes ? 'Yes [OK]' : 'No [CRITICAL]'}`,
        `Has Labels: ${form.accessibility.aiAccessibility.hasLabels ? 'Yes [OK]' : 'No [ISSUE]'}`,
        `CAPTCHA Present: ${form.accessibility.aiAccessibility.hasCaptcha ? 'Yes [BLOCKER]' : 'No [OK]'}`,
        `File Upload: ${form.accessibility.aiAccessibility.hasFileUpload ? 'Yes [COMPLEX]' : 'No [OK]'}`
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

      const visibleFields = form.fields.filter(f => f.type !== 'hidden' && f.type !== 'submit');
      
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
      if (form.accessibility.issues.length > 0) {
        this.currentY += 3;
        this.checkPageBreak(15);
        this.doc.setFontSize(11);
        this.doc.setFont('helvetica', 'bold');
        this.doc.text(this.cleanText('ISSUES FOUND:'), this.margin + 5, this.currentY);
        this.currentY += 7;

        this.doc.setFontSize(10);
        this.doc.setFont('helvetica', 'normal');
        form.accessibility.issues.forEach((issue: string) => {
          this.checkPageBreak(this.lineHeight + 1);
          this.doc.text(this.cleanText(`    • ${issue}`), this.margin + 10, this.currentY);
          this.currentY += this.lineHeight;
        });
      }

      if (form.accessibility.recommendations.length > 0) {
        this.currentY += 3;
        this.checkPageBreak(15);
        this.doc.setFontSize(11);
        this.doc.setFont('helvetica', 'bold');
        this.doc.text(this.cleanText('RECOMMENDATIONS:'), this.margin + 5, this.currentY);
        this.currentY += 7;

        this.doc.setFontSize(10);
        this.doc.setFont('helvetica', 'normal');
        form.accessibility.recommendations.forEach((rec: string) => {
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
      this.doc.text(this.cleanText(`Muse Form Audit Report - Job ID: ${jobId}`), this.margin, 290);
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

  private getFormType(characteristics: FormCharacteristics): string {
    if (characteristics.isContactForm) return 'Contact Form';
    if (characteristics.isSearchForm) return 'Search Form';
    if (characteristics.isLoginForm) return 'Login Form';
    return 'General Form';
  }

  private calculateAIScore(form: AnalyzedForm): number {
    let score = 100;
    
    if (form.characteristics.hasCaptcha) score -= 50;
    if (!form.accessibility.aiAccessibility.hasNameAttributes) score -= 30;
    if (!form.accessibility.aiAccessibility.hasLabels) score -= 20;
    if (form.characteristics.hasFileUpload) score -= 15;
    
    return Math.max(0, score);
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
    return text
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
