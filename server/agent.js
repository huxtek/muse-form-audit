import { CrawlerTools, toolDefinitions, missingCredentialsMessage } from './tools.js';
import { isCancellation } from './lib/cancellation.js';
import { createLlmProvider } from './lib/llm/index.js';
import { analyzeFormWithModel } from './lib/analysis/modelFormAnalyzer.js';
import { attachVisualsToForms } from './lib/visuals/captureFormVisuals.js';
import { getScreenshot, putPageMap, putScreenshot } from './lib/visuals/screenshotStore.js';
import { attachBehaviourToForms } from './lib/analysis/probeFormBehaviour.js';
import { pageUnreadableError } from './lib/pageReadiness.js';

/**
 * AI Agent for autonomous website crawling and form analysis
 * Uses OpenAI GPT-5 with function calling to systematically scan websites
 * Enhanced with token management and rate limiting
 */
export class AIAgent {
  constructor(jobId, targetUrl, fullCrawl, scanTier, progressCallback, modelProvider) {
    this.jobId = jobId;
    this.targetUrl = targetUrl;
    this.fullCrawl = fullCrawl; // Store crawling mode
    this.scanTier = scanTier || 'premium';
    this.progressCallback = progressCallback;
    this.tools = new CrawlerTools();
    // Muse by default; OpenAI stays available so a demo can compare the two.
    this.llm = createLlmProvider(modelProvider);
    this.isRunning = false;
    this.messages = [];
    this.maxIterations = this.fullCrawl ? 30 : 5; // Fewer iterations for single page
    this.currentIteration = 0;
    this.maxTokensPerRequest = 120000; // GPT-5 has enhanced context capabilities
    this.conversationSummary = ''; // Store conversation summary to reduce token usage
    this.scanStartTime = null; // Track scan duration
    /**
     * Aborted by `cancel()`. Separate from `stopRequested`, which means the
     * usage limit was hit and the partial results are worth keeping.
     *
     * A controller rather than a boolean because the slowest thing a scan
     * does is wait on the network, and a boolean can only be noticed between
     * steps. A single model attempt may take MODEL_TIMEOUT_MS -- two minutes
     * by default -- so a flag checked between forms would leave the cancel
     * button looking broken for most of that.
     */
    this.cancelController = new AbortController();
  }

  /** True once the user has cancelled this scan. */
  get isCancelled() {
    return this.cancelController.signal.aborted;
  }

  /**
   * Get rate limiting delay based on scan tier
   */
  getRateLimitDelay() {
    switch (this.scanTier) {
      case 'premium':
        return 0; // No rate limiting for the premium tier
      case 'pro':
        return 1000; // 1 second delay for the pro tier
      case 'free':
      default:
        return 5000; // 5 second delay for the free tier
    }
  }

  /**
   * Get rate limit wait time for 429 errors based on scan tier
   */
  getRateLimitWaitTime() {
    switch (this.scanTier) {
      case 'premium':
        return 10000; // 10 seconds for the premium tier
      case 'pro':
        return 20000; // 20 seconds for the pro tier
      case 'free':
      default:
        return 30000; // 30 seconds for the free tier
    }
  }

  /**
   * Estimate token count (more accurate approximation: 1 token ≈ 3.5 characters for HTML)
   */
  estimateTokens(text) {
    // HTML and code content is more token-dense
    if (text.includes('<') && text.includes('>')) {
      return Math.ceil(text.length / 3.5);
    }
    // Regular text
    return Math.ceil(text.length / 4);
  }

  /**
   * Minimal message management for GPT-5 (enhanced context)
   * Only truncate when absolutely necessary
   */
  async truncateMessages() {
    // Calculate current token usage
    let totalTokens = 0;
    for (const message of this.messages) {
      totalTokens += this.estimateTokens(JSON.stringify(message));
    }
    
    console.log(`📊 Current conversation: ${totalTokens} tokens from ${this.messages.length} messages`);
    
    // Only truncate if we're approaching the 128k limit (use 100k as safety margin)
    if (totalTokens <= 100000) {
      console.log(`✅ Token usage OK for GPT-5, no truncation needed`);
      return;
    }
    
    console.log('🔄 Approaching 128k limit, creating summary and restarting...');
    
    // Create summary of progress
    let coverage;
    try {
      coverage = await this.tools.checkUndiscovered();
    } catch (error) {
      coverage = { visited: [], undiscovered: [], coveragePercentage: 0 };
    }
    
    const formsFound = this.tools.forms?.length || 0;
    this.conversationSummary = `Comprehensive scan progress: ${coverage.visited?.length || 0} pages analyzed, ${coverage.undiscovered?.length || 0} remaining, ${formsFound} forms discovered and analyzed. Full HTML content preserved for accurate form detection.`;
    
    // Start fresh with system message and comprehensive summary
    const systemMessage = this.messages[0];
    const freshMessages = [systemMessage];
    
    // Add detailed progress summary
    freshMessages.push({
      role: "system",
      content: `Previous scan progress: ${this.conversationSummary} Continue with full HTML analysis to ensure no forms are missed.`
    });
    
    // Add instruction to continue
    freshMessages.push({
      role: "user",
      content: "Continue the comprehensive scan with full HTML analysis. Visit the next most important page that likely contains forms, ensuring complete form detection and analysis."
    });
    
    this.messages = freshMessages;
    console.log(`✅ Restarted with ${this.messages.length} messages, preserving full context capability`);
  }

  /**
   * Create a summary of conversation history
   */
  createConversationSummary(messages) {
    const summary = {
      pagesVisited: 0,
      formsFound: 0,
      issuesIdentified: [],
      currentProgress: 'In progress'
    };
    
    // Extract key information from messages
    messages.forEach(message => {
      if (message.role === 'tool') {
        try {
          const toolResult = JSON.parse(message.content);
          if (Array.isArray(toolResult)) {
            if (toolResult.length > 0 && toolResult[0].formId) {
              summary.formsFound += toolResult.length;
            }
          } else if (toolResult.visited) {
            summary.pagesVisited = toolResult.visited.length;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    });
    
    return `Scanned ${summary.pagesVisited} pages, found ${summary.formsFound} forms. Continuing systematic analysis.`;
  }

  /**
   * Streamlined single-page analysis - makes minimal API calls
   */
  async runSinglePageAnalysis() {
    console.log(`\n🎯 === SINGLE PAGE ANALYSIS MODE ===`);
    console.log(`📄 Analyzing: ${this.targetUrl}`);
    
    try {
      this.updateProgress({
        progress: 10,
        currentStep: 'Loading target page...'
      });

      // Step 1: Load the target page
      console.log(`\n1️⃣ Loading page: ${this.targetUrl}`);
      const pageResult = await this.tools.goToPage(this.targetUrl);

      // Same rule as the per-form scan: nothing read is not zero forms.
      if (pageResult.unreadable || !pageResult.html) {
        throw pageUnreadableError({
          url: this.targetUrl,
          reason: pageResult.error
        });
      }

      console.log(`✅ Page loaded: ${pageResult.html.length} characters`);

      this.updateProgress({
        progress: 30,
        currentStep: 'Extracting forms...'
      });

      // Step 2: Extract forms
      console.log(`\n2️⃣ Extracting forms...`);
      const forms = await this.tools.extractForms(pageResult.html);
      console.log(`📝 Found ${forms.length} forms`);

      if (forms.length === 0) {
        console.log(`⚠️  No forms found on the page`);
        await this.finalizeSinglePageScan([], pageResult);
        return;
      }

      this.updateProgress({
        progress: 50,
        currentStep: `Analyzing ${forms.length} forms...`
      });

      // Step 3: Analyze each form
      console.log(`\n3️⃣ Analyzing forms...`);
      const formAnalyses = [];
      
      for (let i = 0; i < forms.length; i++) {
        const form = forms[i];
        console.log(`\n   📋 Analyzing form ${i + 1}/${forms.length}: ${form.formId}`);
        
        try {
          const analysis = await this.tools.analyzeFormAccessibility(form.formHtml);
          formAnalyses.push({
            form,
            analysis
          });
          console.log(`   ✅ Form analyzed: ${analysis.score}/100 accessibility score`);
        } catch (error) {
          console.log(`   ❌ Form analysis failed: ${error.message}`);
          formAnalyses.push({
            form,
            analysis: { error: error.message }
          });
        }

        this.updateProgress({
          progress: 50 + ((i + 1) / forms.length) * 30,
          currentStep: `Analyzed ${i + 1}/${forms.length} forms...`
        });
      }

      this.updateProgress({
        progress: 85,
        currentStep: 'Generating AI summary...'
      });

      // Step 4: Generate AI summary (single API call)
      console.log(`\n4️⃣ Generating AI summary...`);
      await this.generateSinglePageSummary(pageResult, formAnalyses);

    } catch (error) {
      console.error(`❌ Single page analysis failed:`, error);
      // `errorKind` was dropped here, so a page that refused us lost the
      // reason on this route while carrying it on the other two.
      this.updateProgress({
        status: 'failed',
        error: error.message,
        ...(error.pageAccess ? { errorKind: error.pageAccess.kind } : {})
      });
    }
  }

  /**
   * Calculate overall performance prediction
   */
  calculateOverallPerformance(analysis) {
    const categories = analysis.categories || {};
    let totalScore = 0;
    let totalMax = 0;
    
    Object.values(categories).forEach(category => {
      totalScore += category.score || 0;
      totalMax += category.maxScore || 0;
    });
    
    return totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  }

  /**
   * Get performance rating based on score
   */
  getPerformanceRating(analysis) {
    const performance = this.calculateOverallPerformance(analysis);
    
    if (performance >= 85) return 'Excellent';
    if (performance >= 70) return 'Good';
    if (performance >= 50) return 'Fair';
    return 'Poor';
  }

  /**
   * Count critical blockers that prevent AI interaction
   */
  countCriticalBlockers(form, analysis) {
    let blockers = 0;
    
    // CAPTCHA is a critical blocker
    if (analysis.aiAccessibility?.hasCaptcha) blockers++;
    
    // Missing name attributes are critical
    if (!analysis.aiAccessibility?.hasNameAttributes) blockers++;
    
    // No form structure is critical
    if (!analysis.aiAccessibility?.hasProperStructure) blockers++;
    
    // Count fields without names
    const fieldsWithoutNames = form.fields?.filter(f => 
      f.type !== 'hidden' && f.type !== 'submit' && !f.name
    ).length || 0;
    
    if (fieldsWithoutNames > 0) blockers++;
    
    return blockers;
  }

  /**
   * Count partial blockers that reduce AI success rate
   */
  countPartialBlockers(form, analysis) {
    let blockers = 0;
    
    // File uploads are partial blockers
    if (analysis.aiAccessibility?.hasFileUpload) blockers++;
    
    // Missing labels reduce success rate
    if (!analysis.aiAccessibility?.hasLabels) blockers++;
    
    // No autocomplete reduces efficiency
    if (!analysis.aiAccessibility?.hasAutocomplete) blockers++;
    
    // Poor data types reduce accuracy
    if (!analysis.aiAccessibility?.hasDataTypes) blockers++;
    
    return blockers;
  }

  /**
   * Calculate AI compatibility score (separate from accessibility)
   */
  calculateAICompatibilityScore(analysis) {
    let score = 100;
    
    // Critical AI blockers
    if (analysis.aiAccessibility?.hasCaptcha) {
      score -= 50; // Major blocker
    }
    
    if (!analysis.aiAccessibility?.hasNameAttributes) {
      score -= 30; // Critical for form submission
    }
    
    if (!analysis.aiAccessibility?.hasLabels && !analysis.fieldAnalysis?.some(f => f.hasAriaLabel)) {
      score -= 20; // AI can't identify fields
    }
    
    if (analysis.aiAccessibility?.hasFileUpload) {
      score -= 15; // Complex for AI
    }
    
    // Field-level issues
    const fieldIssues = analysis.fieldAnalysis?.filter(f => !f.hasName).length || 0;
    const totalFields = analysis.fieldAnalysis?.length || 1;
    score -= (fieldIssues / totalFields) * 20;
    
    return Math.max(0, Math.round(score));
  }

  /**
   * Identify specific AI blocking issues
   */
  identifyAIBlockingIssues(form, analysis) {
    const blockers = [];
    
    if (analysis.aiAccessibility?.hasCaptcha) {
      blockers.push('CAPTCHA prevents automated form submission');
    }
    
    if (!analysis.aiAccessibility?.hasNameAttributes) {
      blockers.push('Missing name attributes prevent form data submission');
    }
    
    const unnamedFields = form.fields?.filter(f => !f.name).length || 0;
    if (unnamedFields > 0) {
      blockers.push(`${unnamedFields} fields lack name attributes`);
    }
    
    const unlabeledFields = form.fields?.filter(f => !f.label && !f['aria-label'] && !f.placeholder).length || 0;
    if (unlabeledFields > 0) {
      blockers.push(`${unlabeledFields} fields have no identifying labels for AI`);
    }
    
    if (analysis.aiAccessibility?.hasFileUpload) {
      blockers.push('File upload fields require special handling by AI agents');
    }
    
    if (form.method?.toUpperCase() === 'GET' && form.characteristics?.isContactForm) {
      blockers.push('Contact form using GET method may not submit data properly');
    }
    
    return blockers;
  }

  /**
   * Identify AI blockers for specific fields
   */
  identifyFieldAIBlockers(field) {
    const blockers = [];
    
    if (!field.name) {
      blockers.push('No name attribute');
    }
    
    if (!field.label && !field['aria-label'] && !field.placeholder) {
      blockers.push('No identifying label');
    }
    
    if (field.type === 'file') {
      blockers.push('File upload complexity');
    }
    
    if (field.disabled) {
      blockers.push('Field is disabled');
    }
    
    if (field.type === 'hidden') {
      blockers.push('Hidden field');
    }
    
    return blockers;
  }

  /**
   * Generate AI summary for single page analysis with focus on AI agent compatibility
   */
  async generateSinglePageSummary(pageResult, formAnalyses) {
    // Create detailed form analysis focused on AI agent compatibility
    const detailedFormAnalysis = formAnalyses.map(({ form, analysis }) => {
      const formDetails = {
        formId: form.formId,
        fields: form.fields || [],
        fieldCount: form.fields?.length || 0,
        method: form.method || 'GET',
        action: form.action || 'Not specified',
        type: form.characteristics?.isContactForm ? 'Contact' : 
              form.characteristics?.isSearchForm ? 'Search' : 
              form.characteristics?.isLoginForm ? 'Login' : 'General',
        
        // COMPREHENSIVE ANALYSIS RESULTS
        overallScore: analysis.score || 0,
        categories: analysis.categories || {},
        aiCompatibilityScore: this.calculateAICompatibilityScore(analysis),
        aiBlockingIssues: this.identifyAIBlockingIssues(form, analysis),
        aiAccessibility: analysis.aiAccessibility || {},
        
        // PERFORMANCE ESTIMATION DATA
        performanceMetrics: {
          structuralScore: analysis.categories?.structural?.score || 0,
          structuralMax: analysis.categories?.structural?.maxScore || 15,
          identificationScore: analysis.categories?.identification?.score || 0,
          identificationMax: analysis.categories?.identification?.maxScore || 20,
          labelingScore: analysis.categories?.labeling?.score || 0,
          labelingMax: analysis.categories?.labeling?.maxScore || 15,
          submissionScore: analysis.categories?.submission?.score || 0,
          submissionMax: analysis.categories?.submission?.maxScore || 10,
          
          // Calculate success rates
          discoverySuccessRate: Math.round(((analysis.categories?.structural?.score || 0) / 15) * 100),
          identificationSuccessRate: Math.round((((analysis.categories?.identification?.score || 0) + (analysis.categories?.labeling?.score || 0)) / 35) * 100),
          dataEntrySuccessRate: Math.round((((analysis.categories?.dataTypes?.score || 0) + (analysis.categories?.inputHints?.score || 0)) / 25) * 100),
          submissionSuccessRate: Math.round(((analysis.categories?.submission?.score || 0) / 10) * 100),
          
          // Overall performance prediction
          overallPerformance: this.calculateOverallPerformance(analysis),
          performanceRating: this.getPerformanceRating(analysis),
          
          // Critical blocker count
          criticalBlockers: this.countCriticalBlockers(form, analysis),
          partialBlockers: this.countPartialBlockers(form, analysis)
        },
        
        // DETAILED CATEGORY BREAKDOWN
        structuralIssues: analysis.categories?.structural?.issues || [],
        identificationIssues: analysis.categories?.identification?.issues || [],
        labelingIssues: analysis.categories?.labeling?.issues || [],
        inputHintsIssues: analysis.categories?.inputHints?.issues || [],
        dataTypesIssues: analysis.categories?.dataTypes?.issues || [],
        validationIssues: analysis.categories?.validation?.issues || [],
        submissionIssues: analysis.categories?.submission?.issues || [],
        accessibilityIssues: analysis.categories?.accessibility?.issues || []
      };

      // Extract specific field information with comprehensive analysis
      const fieldDetails = form.fields?.map(field => ({
        name: field.name || 'MISSING',
        type: field.type || 'text',
        label: field.label || null,
        placeholder: field.placeholder || null,
        required: field.required || false,
        id: field.id || null,
        ariaLabel: field['aria-label'] || null,
        
        // COMPREHENSIVE FIELD ANALYSIS
        aiCanIdentify: !!(field.name && (field.label || field['aria-label'] || field.placeholder)),
        aiCanFill: !!(field.name && field.type !== 'file' && !field.disabled),
        aiBlockers: this.identifyFieldAIBlockers(field),
        
        // SPECIFIC ATTRIBUTE ANALYSIS
        hasNameAttribute: !!field.name,
        hasIdAttribute: !!field.id,
        hasLabel: !!field.label,
        hasAriaLabel: !!field['aria-label'],
        hasPlaceholder: !!field.placeholder,
        hasAutocomplete: !!field.autocomplete,
        hasProperType: ['email', 'tel', 'number', 'date', 'url', 'password', 'search'].includes(field.type),
        isRequired: !!field.required
      })) || [];

      return {
        ...formDetails,
        fieldDetails
      };
    });

    const summaryPrompt = `COMPREHENSIVE AI AGENT COMPATIBILITY ANALYSIS for ${this.targetUrl}:

ANALYSIS METHODOLOGY: 8-Category Comprehensive Assessment
PRIMARY FOCUS: AI Agent Compatibility Issues (80%)
SECONDARY: Accessibility Recommendations (20%)

PAGE ANALYSIS:
- URL: ${this.targetUrl}
- Page size: ${pageResult.html.length} characters
- Forms found: ${formAnalyses.length}

DETAILED FORM ANALYSIS WITH COMPREHENSIVE CATEGORIES:
${detailedFormAnalysis.map((form, i) => `
FORM ${i + 1}: ${form.formId}
- Type: ${form.type} Form
- Method: ${form.method}
- Action: ${form.action}
- Field Count: ${form.fieldCount}
- OVERALL AI COMPATIBILITY SCORE: ${form.aiCompatibilityScore}/100

COMPREHENSIVE CATEGORY BREAKDOWN:
1. STRUCTURAL & NAVIGATIONAL: ${form.categories.structural?.score || 0}/${form.categories.structural?.maxScore || 15}
   Issues: ${form.structuralIssues.join(', ') || 'None'}

2. IDENTIFICATION & TARGETING: ${form.categories.identification?.score || 0}/${form.categories.identification?.maxScore || 20}
   Issues: ${form.identificationIssues.join(', ') || 'None'}

3. LABELING & SEMANTICS: ${form.categories.labeling?.score || 0}/${form.categories.labeling?.maxScore || 15}
   Issues: ${form.labelingIssues.join(', ') || 'None'}

4. INPUT HINTS & AUTOCOMPLETE: ${form.categories.inputHints?.score || 0}/${form.categories.inputHints?.maxScore || 10}
   Issues: ${form.inputHintsIssues.join(', ') || 'None'}

5. DATA TYPES & CONSTRAINTS: ${form.categories.dataTypes?.score || 0}/${form.categories.dataTypes?.maxScore || 15}
   Issues: ${form.dataTypesIssues.join(', ') || 'None'}

6. VALIDATION & FEEDBACK: ${form.categories.validation?.score || 0}/${form.categories.validation?.maxScore || 10}
   Issues: ${form.validationIssues.join(', ') || 'None'}

7. SUBMISSION HANDLING: ${form.categories.submission?.score || 0}/${form.categories.submission?.maxScore || 10}
   Issues: ${form.submissionIssues.join(', ') || 'None'}

8. ACCESSIBILITY & READABILITY: ${form.categories.accessibility?.score || 0}/${form.categories.accessibility?.maxScore || 5}
   Issues: ${form.accessibilityIssues.join(', ') || 'None'}

DETAILED FIELD-BY-FIELD ANALYSIS:
${form.fieldDetails.map((field, j) => `
  Field ${j + 1}: ${field.name}
  - Type: ${field.type}
  - Has Name Attribute: ${field.hasNameAttribute ? 'YES' : 'NO - CRITICAL ISSUE'}
  - Has ID Attribute: ${field.hasIdAttribute ? 'YES' : 'NO'}
  - Has Label: ${field.hasLabel ? 'YES' : 'NO - AI IDENTIFICATION ISSUE'}
  - Has ARIA Label: ${field.hasAriaLabel ? 'YES' : 'NO'}
  - Has Placeholder: ${field.hasPlaceholder ? 'YES' : 'NO'}
  - Has Autocomplete: ${field.hasAutocomplete ? 'YES' : 'NO'}
  - Has Proper Type: ${field.hasProperType ? 'YES' : 'NO'}
  - Is Required: ${field.isRequired ? 'YES' : 'NO'}
  - AI Can Identify: ${field.aiCanIdentify ? 'YES' : 'NO - CRITICAL'}
  - AI Can Fill: ${field.aiCanFill ? 'YES' : 'NO - CRITICAL'}
  - AI Blockers: ${field.aiBlockers.length > 0 ? field.aiBlockers.join(', ') : 'None'}
  - Current HTML: <${field.type === 'select' ? 'select' : 'input'}${field.type !== 'select' ? ` type="${field.type}"` : ''}${field.name ? ` name="${field.name}"` : ''}${field.id ? ` id="${field.id}"` : ''}${field.placeholder ? ` placeholder="${field.placeholder}"` : ''}${field.ariaLabel ? ` aria-label="${field.ariaLabel}"` : ''}${field.required ? ' required' : ''}>${field.type === 'select' ? '</select>' : ''}
`).join('')}

AI COMPATIBILITY STATUS:
- Has Name Attributes: ${form.aiAccessibility.hasNameAttributes ? 'YES' : 'NO - CRITICAL AI BLOCKER'}
- Has Field Labels: ${form.aiAccessibility.hasLabels ? 'YES' : 'NO - AI IDENTIFICATION ISSUE'}
- Has CAPTCHA: ${form.aiAccessibility.hasCaptcha ? 'YES - MAJOR AI BLOCKER' : 'NO'}
- Has File Upload: ${form.aiAccessibility.hasFileUpload ? 'YES - AI COMPLEXITY' : 'NO'}
- Has Proper Structure: ${form.aiAccessibility.hasProperStructure ? 'YES' : 'NO - STRUCTURAL ISSUE'}
- Has Autocomplete: ${form.aiAccessibility.hasAutocomplete ? 'YES' : 'NO - MISSING AI HINTS'}
- Has Data Types: ${form.aiAccessibility.hasDataTypes ? 'YES' : 'NO - SEMANTIC ISSUE'}

PERFORMANCE ESTIMATION DATA:
- Overall Performance Score: ${form.performanceMetrics.overallPerformance}/100
- Performance Rating: ${form.performanceMetrics.performanceRating}
- Form Discovery Success Rate: ${form.performanceMetrics.discoverySuccessRate}%
- Field Identification Success Rate: ${form.performanceMetrics.identificationSuccessRate}%
- Data Entry Success Rate: ${form.performanceMetrics.dataEntrySuccessRate}%
- Form Submission Success Rate: ${form.performanceMetrics.submissionSuccessRate}%
- Critical Blockers Count: ${form.performanceMetrics.criticalBlockers}
- Partial Blockers Count: ${form.performanceMetrics.partialBlockers}
`).join('\n')}

OVERALL WEBSITE PERFORMANCE SUMMARY:
- Total Forms Analyzed: ${formAnalyses.length}
- Average AI Compatibility Score: ${Math.round(detailedFormAnalysis.reduce((sum, form) => sum + form.aiCompatibilityScore, 0) / detailedFormAnalysis.length)}/100
- Forms with Critical Blockers: ${detailedFormAnalysis.filter(form => form.performanceMetrics.criticalBlockers > 0).length}
- Forms Fully AI Compatible: ${detailedFormAnalysis.filter(form => form.performanceMetrics.overallPerformance >= 85).length}
- Forms Partially AI Compatible: ${detailedFormAnalysis.filter(form => form.performanceMetrics.overallPerformance >= 50 && form.performanceMetrics.overallPerformance < 85).length}
- Forms Not AI Compatible: ${detailedFormAnalysis.filter(form => form.performanceMetrics.overallPerformance < 50).length}

CRITICAL: You must provide a comprehensive analysis in MARKDOWN format following this EXACT structure:

## 🤖 AI Agent Compatibility Report

### Executive Summary
Brief overview focusing on how well AI agents can interact with these forms, mentioning specific scores and critical issues found.

## 📊 Comprehensive Scan Results

### 🎯 AI Performance Estimation
Based on the comprehensive analysis, provide a detailed performance assessment:

**Overall AI Compatibility Rating:** [Excellent/Good/Fair/Poor] - X/100

**Performance Breakdown:**
- **Form Discovery Success Rate:** X% (based on structural analysis)
- **Field Identification Success Rate:** X% (based on identification & labeling scores)
- **Data Entry Success Rate:** X% (based on data types & input hints)
- **Form Submission Success Rate:** X% (based on submission handling)

**Estimated AI Agent Performance:**
- **Successful Interactions:** X out of ${formAnalyses.length} forms can be fully automated
- **Partial Interactions:** X forms have minor issues but are mostly usable
- **Failed Interactions:** X forms have critical blockers preventing AI use

**Performance Impact Analysis:**
- **High Impact Issues:** [List critical blockers affecting performance]
- **Medium Impact Issues:** [List issues causing partial failures]
- **Low Impact Issues:** [List minor optimization opportunities]

**Business Impact Assessment:**
- **Current State:** [How well AI agents can interact with the site today]
- **With Recommended Fixes:** [Expected performance after implementing fixes]
- **ROI Potential:** [Benefits of making forms AI-friendly]

## 🚨 Critical AI Blocking Issues
List the most severe problems that prevent AI agents from using the forms, with specific examples from the analysis above.

## 📋 Form-by-Form AI Analysis

For each form, provide:

### 🤖 Form: [Actual form ID/name]
**AI Compatibility Score:** X/100
**Performance Prediction:** [Excellent/Good/Fair/Poor] - [Specific reason based on analysis]
**Can AI agents use this form?** [Yes/Partially/No] - [Specific reason based on analysis]

#### 🚫 AI Blocking Issues:
For each critical issue found:
- **Issue:** [Specific problem from the analysis]
- **Performance Impact:** [How this affects AI agent success rate]
- **Current HTML:** \`[Show actual HTML from field analysis]\`
- **AI-Friendly HTML:** \`[Show recommended HTML with proper attributes]\`
- **Why AI agents need this:** [Specific explanation]

#### 🔍 Field-by-Field AI Analysis:
For each field, show:
- **Field Name:** [actual name or "MISSING"]
- **AI Can Identify:** [Yes/No based on analysis] - [Performance impact]
- **AI Can Fill:** [Yes/No based on analysis] - [Performance impact]
- **AI Blockers:** [Specific issues from analysis]
- **Success Probability:** [High/Medium/Low] based on field analysis

#### ✅ AI Enhancement Recommendations:
Step-by-step instructions based on the category issues found, with expected performance improvements.

## 🎯 Priority AI Fixes

### 🚀 High Impact Fixes (Immediate Performance Gains)
Ranked list of changes that will provide the biggest performance improvements:

### 📈 Medium Impact Fixes (Moderate Performance Gains)
Changes that will improve reliability and success rates:

### 🔧 Low Impact Fixes (Optimization Opportunities)
Fine-tuning for optimal AI agent performance:

## 🤖 AI Implementation Guide
Specific code changes with before/after examples from the actual field analysis, including expected performance improvements for each fix.

## 📈 Performance Improvement Roadmap

### Phase 1: Critical Fixes (Expected: X% improvement)
- [List critical fixes with performance impact]

### Phase 2: Enhancement Fixes (Expected: X% additional improvement)
- [List enhancement fixes with performance impact]

### Phase 3: Optimization Fixes (Expected: X% additional improvement)
- [List optimization fixes with performance impact]

**Total Expected Performance Improvement:** From X% to Y% AI compatibility

---

## 💡 Bonus: Accessibility Recommendations
*(Secondary focus - general accessibility improvements based on category 8)*

IMPORTANT: Use the specific data provided above. Show actual HTML examples from the field analysis. Reference the specific category scores and issues. Provide concrete before/after code examples based on the actual field data provided. Include specific performance predictions and success rate estimates based on the comprehensive analysis data.`;

    console.log(`📤 Making single AI summary call...`);
    
    const completion = await this.llm.createCompletion({
      messages: [
        {
          role: "system",
          content: "You are an AI agent compatibility specialist. Your PRIMARY focus is analyzing how well AI agents can interact with web forms using comprehensive 8-category analysis. You have been provided with detailed category breakdowns (Structural, Identification, Labeling, Input Hints, Data Types, Validation, Submission, Accessibility) with specific scores and issues for each. Use this comprehensive data to provide specific, actionable feedback. Format your response using proper MARKDOWN. CRITICAL: Reference the specific category scores, field analysis data, and actual HTML examples provided in the analysis. Do not provide generic advice - use the specific findings from the comprehensive analysis."
        },
        {
          role: "user",
          content: summaryPrompt
        }
      ],
      maxTokens: 2000
    });

    const aiSummary = completion.choices[0].message.content;
    console.log(`✅ AI summary generated: ${aiSummary.length} characters`);

    // Finalize the scan
    await this.finalizeSinglePageScan(formAnalyses, pageResult, aiSummary);
  }

  /**
   * Finalize single page scan with results
   */
  async finalizeSinglePageScan(formAnalyses, pageResult, aiSummary = null) {
    const scanResults = {
      summary: {
        totalPages: 1,
        totalForms: formAnalyses.length,
        discoveredUrls: 1,
        visitedUrls: 1,
        coveragePercentage: 100
      },
      forms: formAnalyses.map(({ form, analysis }) => ({
        formId: form.formId,
        url: this.targetUrl,
        characteristics: form.characteristics,
        fields: form.fields,
        accessibility: analysis
      })),
      aiSummary: aiSummary || `Single page analysis completed. Found ${formAnalyses.length} forms on ${this.targetUrl}.`,
      scanMode: 'single-page',
      targetUrl: this.targetUrl
    };

    console.log(`\n🎉 === SINGLE PAGE SCAN COMPLETED ===`);
    console.log(`📄 Page: ${this.targetUrl}`);
    console.log(`📝 Forms found: ${formAnalyses.length}`);
    console.log(`⏰ Duration: ${((Date.now() - this.scanStartTime) / 1000).toFixed(1)}s`);

    this.updateProgress({
      status: 'completed',
      progress: 100,
      currentStep: 'Single page analysis completed',
      results: scanResults
    });

    this.isRunning = false;
    await this.tools.cleanup();
  }

  /**
   * Enhanced conversation loop with detailed logging and real-time updates
   */
  async runConversationLoop() {
    while (this.isRunning && this.currentIteration < this.maxIterations) {
      this.currentIteration++;
      
      try {
        console.log(`\n🤖 === AI ITERATION ${this.currentIteration} ===`);
        
        this.updateProgress({
          progress: Math.min(10 + (this.currentIteration / this.maxIterations) * 80, 90),
          currentStep: `AI thinking... (iteration ${this.currentIteration})`
        });

        // Truncate messages if needed
        await this.truncateMessages();

        // Add subscription-aware rate limiting delay
        if (this.currentIteration > 1) {
          const delay = this.getRateLimitDelay();
          if (delay > 0) {
            console.log(`⏳ Rate limiting delay (${delay/1000}s) for ${this.scanTier} tier...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            console.log(`🚀 No rate limiting for ${this.scanTier} tier`);
          }
        }

        // Estimate total tokens before making request
        const totalTokens = this.messages.reduce((sum, msg) => 
          sum + this.estimateTokens(JSON.stringify(msg)), 0
        );
        
        console.log(`📊 Estimated tokens: ${totalTokens} (limit: ${this.maxTokensPerRequest})`);

        console.log(`📤 Sending to OpenAI:`);
        console.log(`   - Messages: ${this.messages.length}`);
        console.log(`   - Last user message: ${this.messages[this.messages.length - 1]?.content?.substring(0, 100)}...`);

        this.updateProgress({
          currentStep: `Making API call (${totalTokens} tokens)...`
        });

        // Call the selected model with full context
        const completion = await this.llm.createCompletion({
          messages: this.messages,
          tools: toolDefinitions,
          toolChoice: "auto",
          maxTokens: 4000
        });

        // Log the full OpenAI response for debugging
        console.log(`\n📥 === FULL OPENAI RESPONSE ===`);
        console.log(`Model: ${completion.model}`);
        console.log(`Usage:`, completion.usage);
        console.log(`Finish Reason: ${completion.choices[0].finish_reason}`);
        if (completion.choices[0].message.content) {
          console.log(`Content: ${completion.choices[0].message.content}`);
        }
        if (completion.choices[0].message.tool_calls) {
          console.log(`Tool Calls:`, JSON.stringify(completion.choices[0].message.tool_calls, null, 2));
        }
        console.log(`=== END OPENAI RESPONSE ===\n`);

        const message = completion.choices[0].message;
        
        // Log OpenAI's response
        console.log(`📥 OpenAI Response:`);
        if (message.content) {
          console.log(`   💭 AI says: "${message.content}"`);
          
          // Update progress with AI's current thinking
          this.updateProgress({
            currentStep: `AI: ${message.content.substring(0, 100)}${message.content.length > 100 ? '...' : ''}`
          });
        }
        
        if (message.tool_calls && message.tool_calls.length > 0) {
          console.log(`   🔧 AI wants to use ${message.tool_calls.length} tools:`);
          message.tool_calls.forEach((call, index) => {
            console.log(`      ${index + 1}. ${call.function.name}(${JSON.stringify(JSON.parse(call.function.arguments), null, 2).replace(/\n/g, ' ')})`);
          });
        }

        this.messages.push(message);

        // Check if AI wants to use tools
        if (message.tool_calls && message.tool_calls.length > 0) {
          // Process tools one at a time to manage token usage
          for (let i = 0; i < message.tool_calls.length; i++) {
            const toolCall = message.tool_calls[i];
            console.log(`\n🔧 Executing tool ${i + 1}/${message.tool_calls.length}: ${toolCall.function.name}`);
            
            this.updateProgress({
              currentStep: `Executing: ${toolCall.function.name}...`
            });
            
            const result = await this.executeTool(toolCall);
            
            // Special logging for form extraction
            if (toolCall.function.name === 'extractForms') {
              console.log(`🔍 FORM EXTRACTION DEBUG:`);
              console.log(`   📋 Forms found in this call: ${Array.isArray(result) ? result.length : 0}`);
              console.log(`   📊 Total forms accumulated: ${this.tools.forms.length}`);
              if (Array.isArray(result) && result.length > 0) {
                result.forEach((form, idx) => {
                  console.log(`   📝 Form ${idx + 1}: ${form.formId} (${form.fields?.length || 0} fields)`);
                });
              }
            }
            
            // Log tool results
            console.log(`✅ Tool result for ${toolCall.function.name}:`);
            if (typeof result === 'object') {
              if (result.error) {
                console.log(`   ❌ Error: ${result.error}`);
              } else if (Array.isArray(result)) {
                console.log(`   📋 Found ${result.length} items`);
                if (result.length > 0 && result[0].formId) {
                  console.log(`   📝 Forms: ${result.map(f => f.formId).join(', ')}`);
                }
              } else if (result.html) {
                console.log(`   🌐 Page loaded: ${result.originalSize || result.html.length} chars`);
                console.log(`   🔗 Links found: ${result.links?.length || 0}`);
              } else if (result.undiscovered) {
                console.log(`   📊 Coverage: ${result.coveragePercentage}% (${result.visited.length}/${result.totalDiscovered})`);
                console.log(`   🔍 Remaining: ${result.undiscovered.length} pages`);
              } else if (result.score !== undefined) {
                console.log(`   📊 Accessibility score: ${result.score}%`);
                console.log(`   ⚠️  Issues: ${result.issues?.length || 0}`);
              }
            } else {
              console.log(`   📄 Result: ${JSON.stringify(result).substring(0, 200)}...`);
            }
            
            // Truncate large tool results
            const truncatedResult = this.truncateToolResult(result);
            
            // Validate that the result can be safely JSON stringified
            let jsonResult;
            try {
              jsonResult = JSON.stringify(truncatedResult);
              // Test that it can be parsed back
              JSON.parse(jsonResult);
            } catch (jsonError) {
              console.log(`⚠️  JSON serialization issue detected, using fallback...`);
              // Create a safe fallback result
              jsonResult = JSON.stringify({
                success: result.success !== false,
                summary: `Tool ${toolCall.function.name} executed successfully`,
                note: 'Result truncated due to serialization issues',
                originalError: jsonError.message
              });
            }
            
            // Add tool result to conversation
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: jsonResult
            });
          }
        } else {
          // AI provided a text response - check if it's declaring completion
          const content = message.content.toLowerCase();
          if (content.includes('done scanning') || 
              content.includes('scan complete') || 
              content.includes('analysis complete')) {
            
            console.log('🎉 AI declared scan complete!');
            await this.finalizeScan();
            break;
          }
        }

        // Safety check - if we haven't made progress in a while, check status
        if (this.currentIteration % 5 === 0) {
          console.log(`\n📊 Progress check (iteration ${this.currentIteration}):`);
          const coverage = await this.tools.checkUndiscovered();
          console.log(`📈 Coverage: ${coverage.visited.length} visited, ${coverage.undiscovered.length} remaining`);
          console.log(`   📈 Site coverage: ${coverage.coveragePercentage}%`);
          console.log(`   ✅ Pages visited: ${coverage.visited.length}`);
          console.log(`   🔍 Pages remaining: ${coverage.undiscovered.length}`);
          
          // Show sample of remaining high-priority pages
          if (coverage.undiscovered.length > 0) {
            const samplePages = coverage.undiscovered.slice(0, 3);
            const highPriorityPages = samplePages.filter(url => 
              url.toLowerCase().includes('contact') || 
              url.toLowerCase().includes('quote') || 
              url.toLowerCase().includes('signup')
            );
            
            if (highPriorityPages.length > 0) {
              console.log(`   🎯 High-priority pages remaining: ${highPriorityPages.join(', ')}`);
            }
          }
          
          if (coverage.undiscovered.length === 0) {
            console.log('🎉 All pages visited, finalizing scan');
            await this.finalizeScan();
            break;
          }
        }

      } catch (error) {
        console.error(`\n❌ Conversation loop error (iteration ${this.currentIteration}):`, error.message);
        
        // Handle rate limit errors with subscription-aware delays
        if (error.status === 429) {
          const waitTime = this.getRateLimitWaitTime();
          console.log(`⏳ Rate limit hit, waiting ${waitTime/1000} seconds for ${this.scanTier} tier...`);
          this.updateProgress({
            currentStep: `Rate limit reached, waiting ${waitTime/1000}s...`
          });
          
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          console.log('🔄 Resuming with simplified approach...');
          this.messages.push({
            role: "user",
            content: `Rate limit encountered. Please provide a summary of findings so far and continue with a more focused approach, analyzing only the most important pages and forms.`
          });
          continue;
        }
        
        // Handle token limit errors
        if (error.message && error.message.includes('tokens')) {
          console.log('🔄 Token limit exceeded, creating summary and continuing...');
          await this.truncateMessages();
          
          this.messages.push({
            role: "user",
            content: `Token limit reached. Please summarize your findings so far and focus on completing the most critical analysis tasks.`
          });
          continue;
        }
        
        // Handle JSON parsing errors specifically
        if (error.message && error.message.includes('JSON')) {
          console.log('🔧 JSON parsing error detected, attempting recovery...');
          
          // Clear problematic messages and restart with a clean slate
          await this.truncateMessages();
          
          // Get current scan progress
          const coverage = await this.tools.checkUndiscovered();
          
          this.messages.push({
            role: "user",
            content: `JSON parsing error occurred. Current progress: ${coverage.visited.length} pages visited, ${coverage.undiscovered.length} remaining. Please continue the scan with the next most important page that likely contains forms.`
          });
          continue;
        }
        
        // For other errors, try to continue
        console.log('🔄 Attempting to continue after error...');
        this.messages.push({
          role: "user",
          content: `An error occurred: ${error.message}. Please continue with the scan if possible, or provide a summary of what was completed.`
        });
        
        // If we're getting repeated errors, stop
        if (this.currentIteration > 5 && (error.message.includes('rate limit') || error.message.includes('JSON'))) {
          console.log('🛑 Multiple errors detected, finalizing scan...');
          await this.finalizeScan();
          break;
        }
      }
    }

    if (this.currentIteration >= this.maxIterations) {
      console.log(`⏰ Max iterations (${this.maxIterations}) reached, finalizing scan`);
      await this.finalizeScan();
    }
  }

  /**
   * Minimal tool result processing for GPT-5 (enhanced context)
   * Only remove truly unnecessary data, preserve form content
   */
  truncateToolResult(result) {
    if (typeof result === 'string') {
      // Only truncate extremely large strings (>50k chars)
      return result.length > 50000 ? this.safeTruncateString(result, 50000) : result;
    }
    
    if (typeof result === 'object' && result !== null) {
      const processed = { ...result };
      
      // Only remove network logs and response HTML which aren't essential for form analysis
      if (processed.networkLog && Array.isArray(processed.networkLog)) {
        delete processed.networkLog; // Remove network logs to save tokens
      }
      
      if (processed.responseHtml && processed.responseHtml.length > 10000) {
        delete processed.responseHtml; // Remove large response HTML
      }
      
      // Keep all form-related content intact
      // Keep HTML content intact for proper form detection
      // Keep links for navigation
      // Keep all form analysis data
      
      return processed;
    }
    
    return result;
  }

  /**
   * Safely truncate strings to prevent JSON parsing issues
   */
  safeTruncateString(str, maxLength) {
    if (str.length <= maxLength) {
      return str;
    }
    
    // Find a safe truncation point
    let truncateAt = maxLength;
    
    // Look backwards for a safe break point
    for (let i = maxLength; i > maxLength - 100 && i > 0; i--) {
      const char = str[i];
      
      // Safe break points: spaces, newlines, end of tags
      if (char === ' ' || char === '\n' || char === '>' || char === '}' || char === ']') {
        truncateAt = i;
        break;
      }
    }
    
    const truncated = str.substring(0, truncateAt);
    
    // Check for unclosed quotes that could break JSON
    const doubleQuotes = (truncated.match(/"/g) || []).length;
    const singleQuotes = (truncated.match(/'/g) || []).length;
    
    // If we have unmatched quotes, find a safer truncation point
    if (doubleQuotes % 2 !== 0 || singleQuotes % 2 !== 0) {
      // Find the last complete "word" or tag
      const lastSafePoint = Math.max(
        truncated.lastIndexOf(' '),
        truncated.lastIndexOf('>'),
        truncated.lastIndexOf('\n')
      );
      
      if (lastSafePoint > truncateAt - 200) {
        return str.substring(0, lastSafePoint) + '...[truncated]';
      }
    }
    
    return truncated + '...[truncated]';
  }

  /**
   * Start the autonomous scanning process with enhanced error handling and logging
   */
  async startScan() {
    if (!this.llm.isConfigured()) {
      throw new Error(missingCredentialsMessage());
    }

    console.log(`\n🚀 === STARTING AI SCAN ===`);
    console.log(`🆔 Job ID: ${this.jobId}`);
    console.log(`🌐 Target URL: ${this.targetUrl}`);
    console.log(`🎯 Crawling Mode: ${this.fullCrawl ? 'FULL WEBSITE CRAWL' : 'SINGLE PAGE ANALYSIS'}`);
    console.log(`🤖 AI Model: ${this.llm.model} (provider: ${this.llm.label})`);
    console.log(`👤 Scan tier: ${this.scanTier.toUpperCase()}`);
    console.log(`⏱️  Rate Limiting: ${this.getRateLimitDelay() === 0 ? 'DISABLED' : `${this.getRateLimitDelay()/1000}s delay`}`);
    console.log(`⚙️  Max iterations: ${this.maxIterations}`);
    console.log(`📊 Token limit per request: ${this.maxTokensPerRequest}`);
    console.log(`🔍 HTML truncation: DISABLED (full content analysis)`);
    console.log(`⏰ Started at: ${new Date().toLocaleString()}`);

    this.isRunning = true;
    this.currentIteration = 0;
    this.scanStartTime = Date.now(); // Track when scan started

    try {
      this.updateProgress({
        status: 'running',
        progress: 5,
        currentStep: 'Initializing AI agent...'
      });

      // Initialize the conversation with mode-specific system prompt
      console.log(`\n📝 Setting up AI conversation...`);
      console.log(`🎯 Crawling mode: ${this.fullCrawl ? 'FULL WEBSITE CRAWL' : 'SINGLE PAGE ANALYSIS'}`);
      
      const systemPrompt = this.fullCrawl ? 
        // Full crawling mode prompt
        `You are an expert web crawler and form accessibility analyst. Your mission is to DYNAMICALLY DISCOVER and analyze ALL forms on the website through intelligent crawling.

DYNAMIC CRAWLING WORKFLOW:

1. **DISCOVER PAGES**: 
   - Start with fetchSitemap() to find initial pages
   - Use goToPage() on homepage to discover links
   - Follow links systematically to map the entire site

2. **PRIORITIZE INTELLIGENTLY**:
   - HIGH PRIORITY: contact, feedback, quote, signup, login pages
   - MEDIUM PRIORITY: about, services, booking, homepage
   - LOW PRIORITY: blog, gallery, general content pages

3. **COMPREHENSIVE ANALYSIS**:
   - Use checkUndiscovered() to track crawling progress
   - Visit pages in priority order (forms-likely first)
   - Extract and analyze ALL forms found: extractForms() → analyzeFormAccessibility()

4. **EFFICIENT CRAWLING**:
   - Don't revisit pages unnecessarily
   - Focus on pages most likely to contain forms
   - Build a complete picture of the website's form landscape

TARGET: Find ALL forms across the ENTIRE website through systematic discovery.

Start by discovering the website structure, then analyze forms comprehensively.`
        :
        // Single page mode prompt
        `You are an expert form accessibility analyst. Your mission is to THOROUGHLY ANALYZE the single provided URL for form accessibility and AI compatibility.

SINGLE PAGE ANALYSIS WORKFLOW:

1. **ANALYZE TARGET PAGE**:
   - Use goToPage() to load the provided URL: ${this.targetUrl}
   - Extract ALL forms using extractForms()
   - Analyze each form with analyzeFormAccessibility()

2. **COMPREHENSIVE FORM ANALYSIS**:
   - Identify all form types (contact, search, login, etc.)
   - Test accessibility and AI compatibility
   - Provide detailed recommendations for each form

3. **FOCUSED REPORTING**:
   - Focus on the single page provided
   - Do NOT crawl other pages or follow links
   - Provide thorough analysis of found forms

TARGET: Complete analysis of ALL forms on the single provided URL.

Start by analyzing the target URL: ${this.targetUrl}`;

      this.messages = [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: this.fullCrawl 
            ? `Begin DYNAMIC CRAWLING of ${this.targetUrl}. Start with sitemap discovery, then systematically crawl and discover all pages. Focus on finding and analyzing every form on the website through intelligent page prioritization.`
            : `Analyze the single URL: ${this.targetUrl}. Load this page, extract all forms, and provide comprehensive accessibility analysis. Do not crawl other pages.`
        }
      ];

      console.log(`✅ AI conversation initialized with ${this.messages.length} messages`);
      
      if (this.fullCrawl) {
        console.log(`🌐 Starting full website crawl mode...`);
        console.log(`🎯 Starting conversation loop...`);
        // Start the AI conversation loop for full crawling
        await this.runConversationLoop();
      } else {
        console.log(`📄 Starting streamlined single page analysis...`);
        // Use direct analysis for single page (no conversation loop)
        await this.runSinglePageAnalysis();
      }

    } catch (error) {
      console.error(`\n❌ === SCAN FAILED ===`);
      console.error(`🆔 Job ID: ${this.jobId}`);
      console.error(`❌ Error: ${error.message}`);
      console.error(`🔄 Iteration: ${this.currentIteration}`);
      
      // `pageAccess` carries why the target could not be read, so this says
      // which side the problem is on rather than a bare "Scan failed".
      this.updateProgress({
        status: 'failed',
        error: error.message,
        currentStep: error.pageAccess
          ? error.pageAccess.status
            ? `Could not read the page (HTTP ${error.pageAccess.status})`
            : 'Could not read the page'
          : 'Scan failed',
        ...(error.pageAccess ? { errorKind: error.pageAccess.kind } : {})
      });
      throw error;
    } finally {
      console.log(`🧹 Cleaning up resources...`);
      await this.cleanup();
    }
  }

  /**
   * Execute a tool call from the AI with detailed logging
   */
  async executeTool(toolCall) {
    const { name, arguments: args } = toolCall.function;
    const parsedArgs = JSON.parse(args);

    console.log(`\n🔧 === TOOL EXECUTION: ${name} ===`);
    console.log(`📝 Arguments:`, parsedArgs);

    try {
      let result;
      const startTime = Date.now();
      
      switch (name) {
        case 'fetchSitemap':
          console.log(`🗺️  Fetching sitemap from: ${parsedArgs.baseUrl}`);
          result = await this.tools.fetchSitemap(parsedArgs.baseUrl);
          console.log(`✅ Sitemap result: Found ${Array.isArray(result) ? result.length : 0} URLs`);
          if (Array.isArray(result) && result.length > 0) {
            console.log(`   📋 Sample URLs: ${result.slice(0, 3).join(', ')}${result.length > 3 ? '...' : ''}`);
          }
          break;
          
        case 'goToPage':
          console.log(`🌐 Navigating to: ${parsedArgs.url}`);
          result = await this.tools.goToPage(parsedArgs.url);
          console.log(`✅ Page loaded successfully`);
          console.log(`   📄 HTML size: ${result.originalSize || 'unknown'} chars (truncated to ${result.truncatedSize || 'unknown'})`);
          console.log(`   🔗 Links found: ${result.links?.length || 0}`);
          console.log(`   📊 HTTP status: ${result.status || 'unknown'}`);
          
          if (result.links && result.links.length > 0) {
            console.log(`   🔗 Sample links: ${result.links.slice(0, 3).join(', ')}${result.links.length > 3 ? '...' : ''}`);
          }
          
          this.updateProgress({
            currentStep: `Analyzed page: ${parsedArgs.url} (${result.links?.length || 0} links found)`
          });
          break;
          
        case 'extractForms':
          console.log(`📝 Extracting forms from HTML (${parsedArgs.html?.length || 0} chars)`);
          result = await this.tools.extractForms(parsedArgs.html);
          console.log(`✅ Form extraction complete: Found ${result.length} forms`);
          
          if (result.length > 0) {
            result.forEach((form, index) => {
              console.log(`   📋 Form ${index + 1}: ${form.formId} (${form.fields?.length || 0} fields)`);
              console.log(`      - Method: ${form.method}, Action: ${form.action || 'same page'}`);
              console.log(`      - Has CAPTCHA: ${form.characteristics?.hasCaptcha ? 'Yes' : 'No'}`);
              console.log(`      - File upload: ${form.characteristics?.hasFileUpload ? 'Yes' : 'No'}`);
            });
          }
          break;
          
        case 'fillForm':
          console.log(`📝 Attempting to fill form at: ${parsedArgs.formUrl}`);
          result = await this.tools.fillForm(parsedArgs.formHtml, parsedArgs.formUrl);
          console.log(`✅ Form filling attempt complete`);
          console.log(`   🎯 Success: ${result.success ? 'Yes' : 'No'}`);
          console.log(`   📝 Fields filled: ${result.filledFields?.length || 0}`);
          console.log(`   ⚠️  Validation errors: ${result.validationErrors?.length || 0}`);
          
          if (result.error) {
            console.log(`   ❌ Error: ${result.error}`);
          }
          break;
          
        case 'analyzeFormAccessibility':
          console.log(`🔍 Analyzing form accessibility...`);
          result = await this.tools.analyzeFormAccessibility(parsedArgs.formHtml);
          console.log(`✅ Accessibility analysis complete`);
          console.log(`   📊 Overall score: ${result.score}/${result.maxScore}`);
          console.log(`   ⚠️  Issues found: ${result.issues?.length || 0}`);
          console.log(`   💡 Recommendations: ${result.recommendations?.length || 0}`);
          
          if (result.issues && result.issues.length > 0) {
            console.log(`   🚨 Top issues:`);
            result.issues.slice(0, 3).forEach((issue, index) => {
              console.log(`      ${index + 1}. [${issue.severity}] ${issue.message}`);
            });
          }
          
          if (result.aiAccessibility) {
            console.log(`   🤖 AI Accessibility:`);
            console.log(`      - Has labels: ${result.aiAccessibility.hasLabels ? 'Yes' : 'No'}`);
            console.log(`      - Has CAPTCHA: ${result.aiAccessibility.hasCaptcha ? 'Yes' : 'No'}`);
            console.log(`      - Name attributes: ${result.aiAccessibility.hasNameAttributes ? 'Yes' : 'No'}`);
          }
          break;
          
        case 'prioritizePages':
          console.log(`🎯 Prioritizing pages for form analysis...`);
          result = await this.tools.prioritizePages();
          console.log(`✅ Page prioritization complete`);
          console.log(`   📊 Total pages: ${result.totalPages}`);
          console.log(`   🎯 High priority: ${result.highPriority.length}`);
          console.log(`   📊 Medium priority: ${result.mediumPriority.length}`);
          console.log(`   📋 Low priority: ${result.lowPriority.length}`);
          break;
          
        case 'checkUndiscovered':
          console.log(`📊 Checking crawling progress...`);
          result = await this.tools.checkUndiscovered();
          console.log(`✅ Progress check complete`);
          console.log(`   📈 Coverage: ${result.coveragePercentage}%`);
          console.log(`   ✅ Visited: ${result.visited?.length || 0} pages`);
          console.log(`   🔍 Remaining: ${result.undiscovered?.length || 0} pages`);
          console.log(`   📊 Total discovered: ${result.totalDiscovered || 0} pages`);
          
          if (result.undiscovered && result.undiscovered.length > 0) {
            console.log(`   🔍 Next pages to visit: ${result.undiscovered.slice(0, 3).join(', ')}${result.undiscovered.length > 3 ? '...' : ''}`);
          }
          
          this.updateProgress({
            progress: Math.min(20 + (result.coveragePercentage * 0.7), 90),
            currentStep: `Coverage: ${result.coveragePercentage}% (${result.visited?.length || 0}/${result.totalDiscovered || 0} pages)`
          });
          break;
          
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      
      const duration = Date.now() - startTime;
      console.log(`⏱️  Tool execution time: ${duration}ms`);
      
      return result;
      
    } catch (error) {
      console.error(`❌ Tool execution error (${name}):`, error.message);
      console.error(`   🔍 Arguments were:`, parsedArgs);
      
      return {
        error: error.message,
        success: false,
        toolName: name,
        arguments: parsedArgs
      };
    }
  }

  /**
   * Finalize the scan and generate the final report with detailed logging
   */
  async finalizeScan() {
    console.log(`\n🎯 === FINALIZING SCAN ===`);
    
    this.updateProgress({
      progress: 95,
      currentStep: 'Generating comprehensive report...'
    });

    try {
      // Get comprehensive results from tools
      console.log(`📊 Gathering scan results...`);
      const scanResults = this.tools.getScanResults();
      
      console.log(`✅ Scan results summary:`);
      console.log(`   📄 Total pages scanned: ${scanResults.summary?.totalPages || 0}`);
      console.log(`   📝 Total forms found: ${scanResults.summary?.totalForms || 0}`);
      console.log(`   📊 Site coverage: ${scanResults.summary?.coveragePercentage || 0}%`);
      console.log(`   🔗 URLs discovered: ${scanResults.summary?.discoveredUrls || 0}`);
      
      // Detailed form debugging
      console.log(`\n🔍 DETAILED FORM DEBUG:`);
      console.log(`   📋 Forms array length: ${scanResults.forms?.length || 0}`);
      if (scanResults.forms && scanResults.forms.length > 0) {
        scanResults.forms.forEach((form, idx) => {
          console.log(`   📝 Form ${idx + 1}: ${form.formId} from ${form.url || 'unknown URL'}`);
          console.log(`      - Fields: ${form.fields?.length || 0}`);
          console.log(`      - Action: ${form.action || 'none'}`);
          console.log(`      - Method: ${form.method || 'GET'}`);
        });
      } else {
        console.log(`   ⚠️  NO FORMS FOUND IN FINAL RESULTS!`);
        console.log(`   🔍 Tools.forms array: ${this.tools.forms?.length || 0}`);
        console.log(`   🔍 Visited pages: ${Array.from(this.tools.visited).join(', ')}`);
      }
      // Generate detailed AI summary with specific instructions
      console.log(`🤖 Requesting comprehensive analysis from AI...`);
      
      // Get final crawling statistics
      const finalCoverage = await this.tools.checkUndiscovered();
      
      // Create a concise summary of what was found instead of sending full conversation
      const scanSummary = `${this.fullCrawl ? 'DYNAMIC WEBSITE CRAWL' : 'SINGLE PAGE ANALYSIS'} COMPLETED for ${this.targetUrl}:

SCAN CONFIGURATION:
- Mode: ${this.fullCrawl ? 'Full website crawling with page discovery' : 'Single page analysis only'}
- Target: ${this.targetUrl}
- Pages discovered: ${finalCoverage.totalDiscovered || scanResults.summary?.discoveredUrls || 1}
- Pages visited: ${finalCoverage.visited?.length || scanResults.summary?.totalPages || 1}
- Site coverage: ${finalCoverage.coveragePercentage || scanResults.summary?.coveragePercentage || 100}%
- Forms found: ${scanResults.summary?.totalForms || 0}

${this.fullCrawl ? 
  `DISCOVERY METHOD: Dynamic crawling with intelligent page prioritization
- Started with sitemap discovery
- Followed links systematically from homepage
- Prioritized form-likely pages (contact, quote, signup)
- Comprehensive form analysis on all discovered pages` :
  `ANALYSIS METHOD: Focused single-page analysis
- Analyzed only the provided URL
- Extracted all forms from the target page
- Comprehensive AI compatibility analysis of found forms`
}

Please provide a comprehensive AI AGENT COMPATIBILITY report focusing on:
1. PRIMARY (80%): How well AI agents can interact with the discovered forms
2. SECONDARY (20%): General accessibility improvements as bonus recommendations
3. Specific AI blocking issues and how to fix them
4. Concrete before/after examples for AI agent improvements

Focus on AI agent needs: name attributes, field identification, form submission capability, and automation blockers.`;

      const finalCompletion = await this.llm.createCompletion({
        messages: [
          {
            role: "system", 
            content: "You are an AI agent compatibility specialist focusing on dynamic website crawling. Your PRIMARY mission is analyzing how well AI agents can interact with web forms across entire websites. Accessibility is SECONDARY. Format your response using proper MARKDOWN. CRITICAL: Focus 80% on AI agent compatibility issues, 20% on general accessibility. Provide specific examples showing what AI agents encounter vs what they need to function properly."
          },
          {
            role: "user",
            content: scanSummary
          }
        ],
        maxTokens: 2000
      });

      const detailedReport = finalCompletion.choices[0].message.content;
      
      console.log(`📝 AI Detailed Report Generated`);

      // Compile comprehensive final results
      const results = {
        ...scanResults,
        aiSummary: detailedReport,
        detailedAnalysis: {
          pagesAnalyzed: this.generatePageAnalysis(scanResults),
          formDetails: this.generateFormDetails(scanResults),
          accessibilityMetrics: this.generateAccessibilityMetrics(scanResults),
          recommendations: this.generateSpecificRecommendations(scanResults)
        },
        scanMetadata: {
          jobId: this.jobId,
          targetUrl: this.targetUrl,
          completedAt: new Date().toISOString(),
          iterations: this.currentIteration,
          totalMessages: this.messages.length,
          scanDuration: Date.now() - this.scanStartTime,
          tokenManagement: 'Enhanced with truncation and rate limiting'
        }
      };

      console.log(`\n🎉 === COMPREHENSIVE SCAN COMPLETED ===`);
      console.log(`   🆔 Job ID: ${this.jobId}`);
      console.log(`   🌐 Target URL: ${this.targetUrl}`);
      console.log(`   📄 Pages analyzed: ${results.detailedAnalysis.pagesAnalyzed.length}`);
      console.log(`   📝 Forms found: ${results.detailedAnalysis.formDetails.length}`);
      console.log(`   🔄 AI Iterations: ${this.currentIteration}`);
      console.log(`   ⏱️  Total duration: ${Math.round((Date.now() - this.scanStartTime) / 1000)}s`);

      this.updateProgress({
        status: 'completed',
        progress: 100,
        currentStep: 'Comprehensive scan completed! 🎉',
        results
      });
      
    } catch (error) {
      console.error(`❌ Finalization error:`, error.message);
      console.log(`🔄 Providing partial results...`);
      
      this.updateProgress({
        status: 'completed_with_errors',
        progress: 100,
        currentStep: 'Scan completed with errors',
        error: error.message,
        results: this.tools.getScanResults()
      });
    }
  }

  /**
   * Generate detailed page-by-page analysis
   */
  generatePageAnalysis(scanResults) {
    const pagesAnalyzed = [];
    const visitedPages = scanResults.pages || [];
    const forms = scanResults.forms || [];
    
    visitedPages.forEach(pageUrl => {
      const pageForms = forms.filter(form => form.url === pageUrl);
      
      pagesAnalyzed.push({
        url: pageUrl,
        formsFound: pageForms.length,
        forms: pageForms.map(form => ({
          id: form.formId,
          method: form.method,
          action: form.action,
          fieldCount: form.fields?.length || 0,
          characteristics: form.characteristics,
          accessibilityIssues: this.analyzeFormIssues(form)
        })),
        pageType: this.determinePageType(pageUrl),
        timestamp: new Date().toISOString()
      });
    });
    
    return pagesAnalyzed;
  }

  /**
   * Generate detailed form analysis
   */
  generateFormDetails(scanResults) {
    const forms = scanResults.forms || [];
    
    return forms.map(form => ({
      formId: form.formId,
      url: form.url,
      purpose: this.determineFormPurpose(form),
      accessibility: {
        hasLabels: form.fields?.some(f => f.label) || false,
        hasNameAttributes: form.fields?.every(f => f.name) || false,
        hasAriaLabels: form.fields?.some(f => f.ariaLabel) || false,
        hasCaptcha: form.characteristics?.hasCaptcha || false,
        hasFileUpload: form.characteristics?.hasFileUpload || false
      },
      aiCompatibility: {
        fillable: !form.characteristics?.hasCaptcha && form.fields?.every(f => f.name),
        blockers: this.identifyAIBlockers(form),
        score: this.calculateFormScore(form)
      },
      fields: form.fields?.map(field => ({
        name: field.name,
        type: field.type,
        required: field.required,
        hasLabel: !!field.label,
        hasAriaLabel: !!field.ariaLabel,
        issues: this.identifyFieldIssues(field)
      })) || []
    }));
  }

  /**
   * Generate accessibility metrics
   */
  generateAccessibilityMetrics(scanResults) {
    const forms = scanResults.forms || [];
    const totalForms = forms.length;
    
    if (totalForms === 0) {
      return {
        totalForms: 0,
        aiAccessibleForms: 0,
        formsWithCaptcha: 0,
        formsWithoutLabels: 0,
        averageAccessibilityScore: 0
      };
    }
    
    const aiAccessibleForms = forms.filter(form => 
      !form.characteristics?.hasCaptcha && 
      form.fields?.every(f => f.name)
    ).length;
    
    const formsWithCaptcha = forms.filter(form => 
      form.characteristics?.hasCaptcha
    ).length;
    
    const formsWithoutLabels = forms.filter(form =>
      !form.fields?.some(f => f.label || f.ariaLabel)
    ).length;
    
    return {
      totalForms,
      aiAccessibleForms,
      formsWithCaptcha,
      formsWithoutLabels,
      averageAccessibilityScore: Math.round(
        forms.reduce((sum, form) => sum + this.calculateFormScore(form), 0) / totalForms
      )
    };
  }

  /**
   * Generate specific recommendations
   */
  generateSpecificRecommendations(scanResults) {
    const recommendations = [];
    const forms = scanResults.forms || [];
    const pages = scanResults.pages || [];
    
    // Page-level recommendations
    if (pages.length === 0) {
      recommendations.push({
        priority: 'high',
        category: 'crawling',
        issue: 'No pages could be analyzed',
        recommendation: 'Check website accessibility and sitemap.xml availability'
      });
    }
    
    // Form-level recommendations
    if (forms.length === 0) {
      recommendations.push({
        priority: 'medium',
        category: 'forms',
        issue: 'No forms found on analyzed pages',
        recommendation: 'Consider adding contact forms on key pages for user engagement'
      });
    } else {
      forms.forEach(form => {
        if (form.characteristics?.hasCaptcha) {
          recommendations.push({
            priority: 'high',
            category: 'ai-blocking',
            issue: `Form ${form.formId} has CAPTCHA`,
            recommendation: 'Consider removing CAPTCHA or providing API access for legitimate automation'
          });
        }
        
        if (!form.fields?.some(f => f.label || f.ariaLabel)) {
          recommendations.push({
            priority: 'medium',
            category: 'accessibility',
            issue: `Form ${form.formId} lacks proper labels`,
            recommendation: 'Add proper labels or ARIA labels to all form fields'
          });
        }
      });
    }
    
    return recommendations;
  }

  /**
   * Helper methods for analysis
   */
  determinePageType(url) {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('contact')) return 'Contact Page';
    if (urlLower.includes('about')) return 'About Page';
    if (urlLower.includes('service')) return 'Service Page';
    if (urlLower.includes('home') || urlLower === this.targetUrl) return 'Homepage';
    return 'General Page';
  }

  determineFormPurpose(form) {
    const formHtml = form.formHtml?.toLowerCase() || '';
    const action = form.action?.toLowerCase() || '';
    
    if (formHtml.includes('search') || action.includes('search')) return 'Search Form';
    if (formHtml.includes('contact') || action.includes('contact')) return 'Contact Form';
    if (formHtml.includes('newsletter') || formHtml.includes('subscribe')) return 'Newsletter Form';
    if (formHtml.includes('login') || formHtml.includes('signin')) return 'Login Form';
    return 'General Form';
  }

  calculateFormScore(form) {
    let score = 100;
    
    if (form.characteristics?.hasCaptcha) score -= 40;
    if (form.characteristics?.hasFileUpload) score -= 10;
    if (!form.fields?.some(f => f.label || f.ariaLabel)) score -= 30;
    if (!form.fields?.every(f => f.name)) score -= 20;
    
    return Math.max(0, score);
  }

  identifyAIBlockers(form) {
    const blockers = [];
    
    if (form.characteristics?.hasCaptcha) blockers.push('CAPTCHA protection');
    if (form.characteristics?.hasFileUpload) blockers.push('File upload required');
    if (!form.fields?.every(f => f.name)) blockers.push('Missing name attributes');
    if (!form.fields?.some(f => f.label || f.ariaLabel)) blockers.push('No accessible labels');
    
    return blockers;
  }

  identifyFieldIssues(field) {
    const issues = [];
    
    if (!field.name) issues.push('Missing name attribute');
    if (!field.label && !field.ariaLabel) issues.push('No accessible label');
    if (field.required && !field.label) issues.push('Required field without clear label');
    
    return issues;
  }

  analyzeFormIssues(form) {
    const issues = [];
    
    if (form.characteristics?.hasCaptcha) {
      issues.push('CAPTCHA prevents automated form filling');
    }
    
    if (!form.fields?.some(f => f.label || f.ariaLabel)) {
      issues.push('Form lacks proper field labels');
    }
    
    if (!form.fields?.every(f => f.name)) {
      issues.push('Some fields missing name attributes');
    }
    
    return issues;
  }

  /**
   * Start per-form analysis scan - discovers forms first, then analyzes each one individually
   */
  async startPerFormScan() {
    console.log(`\n🚀 === STARTING PER-FORM SCAN ===`);
    console.log(`🎯 Target: ${this.targetUrl}`);
    console.log(`👤 Scan tier: ${this.scanTier}`);
    console.log(`📊 Job ID: ${this.jobId}`);
    
    this.isRunning = true;
    this.scanStartTime = Date.now();
    this.stopRequested = false;
    
    try {
      // Step 1: Initialize browser and discover forms
      this.updateProgress({
        status: 'running',
        progress: 10,
        currentStep: 'Initializing browser and discovering forms...'
      });
      
      await this.tools.initBrowser();
      
      // Navigate to the page and get HTML content
      const pageData = await this.tools.goToPage(this.targetUrl);

      /*
       * Zero characters of HTML is never a finding about a page's forms.
       *
       * `goToPage` returns empty HTML for a navigation failure so that a
       * multi-page crawl can step over one bad page. This scan has a single
       * page, so there is nothing to step over: carrying on parsed an empty
       * string, found no `<form>` in it, and reported "Scan completed - no
       * forms found". united.com read exactly that way for months.
       */
      if (pageData.unreadable || !pageData.html) {
        throw pageUnreadableError({
          url: this.targetUrl,
          reason: pageData.error
        });
      }

      // Step 2: Extract all forms from the page
      this.updateProgress({
        status: 'running',
        progress: 20,
        currentStep: 'Extracting forms from page...'
      });
      
      // Loading the page is the first slow step, so this is the earliest
      // point a cancel pressed during startup can be honoured.
      if (this.isCancelled) {
        await this.finishCancelled('before any form was analysed');

        return;
      }

      const extractedForms = await this.tools.extractForms(pageData.html);
      // Pair each form with its screenshot geometry; image bytes go to the
      // screenshot store so they never travel inside the results JSON.
      const formsData = attachVisualsToForms({
        forms: attachBehaviourToForms(extractedForms, pageData.formBehaviour),
        visuals: pageData.formVisuals,
        jobId: this.jobId,
        putScreenshot,
        pageMap: pageData.pageMap,
        pageIndex: 0,
        putPageMap
      });
      const formsCount = formsData.length;
      
      console.log(`🔍 Discovered ${formsCount} forms on ${this.targetUrl}`);
      
      // Notify about forms discovered
      this.updateProgress({
        type: 'forms_discovered',
        status: 'running',
        progress: 30,
        currentStep: `Found ${formsCount} forms. Starting individual analysis...`,
        formsCount: formsCount
      });
      
      if (formsCount === 0) {
        // No forms found
        const results = {
          url: this.targetUrl,
          timestamp: new Date().toISOString(),
          jobId: this.jobId,
          forms: [],
          summary: {
            totalForms: 0,
            totalPages: 1,
            discoveredUrls: 1,
            visitedUrls: 1,
            coveragePercentage: 100,
            aiSummary: `No forms found on ${this.targetUrl}. The page was successfully scanned but contains no form elements.`,
            scanMode: 'per-form-analysis'
          },
          metadata: {
            targetUrl: this.targetUrl,
            analysisTime: Date.now() - this.scanStartTime,
            perFormMode: true
          }
        };
        
        this.updateProgress({
          status: 'completed',
          progress: 100,
          currentStep: 'Scan completed - no forms found',
          results: results
        });
        
        this.isRunning = false;
        await this.tools.cleanup();
        return;
      }
      
      // Step 3: Analyze each form individually
      const analyzedForms = [];
      let formsAnalyzed = 0;
      
      for (let i = 0; i < formsCount; i++) {
        // Two different reasons to stop, with two different outcomes. The
        // usage limit keeps the forms already scored; a cancel publishes
        // nothing, so it leaves through `finishCancelled` instead of
        // breaking into the report-building code below.
        if (this.isCancelled) {
          await this.finishCancelled(`after ${formsAnalyzed} of ${formsCount} forms`);

          return;
        }

        if (this.stopRequested) {
          console.log(`🛑 Stopping per-form analysis due to usage limit`);
          break;
        }
        
        const form = formsData[i];
        const formProgress = 30 + ((i + 1) / formsCount) * 60; // Progress from 30% to 90%
        
        this.updateProgress({
          status: 'running',
          progress: Math.round(formProgress),
          currentStep: `Analyzing form ${i + 1} of ${formsCount}: ${form.formId || 'unnamed form'}...`
        });
        
        try {
          // Analyze this specific form
          const formAnalysis = await this.analyzeIndividualForm(form);
          analyzedForms.push(formAnalysis);
          formsAnalyzed++;
          
          console.log(`✅ Form ${i + 1}/${formsCount} analyzed: ${form.formId}`);
          
          // Notify about individual form completion
          this.updateProgress({
            type: 'form_analyzed',
            status: 'running',
            progress: Math.round(formProgress),
            currentStep: `Completed analysis of form ${i + 1} of ${formsCount}`,
            formData: {
              formId: form.formId,
              formIndex: i + 1,
              totalForms: formsCount,
              analysis: formAnalysis
            }
          });
          
          // Add a small delay between forms to avoid overwhelming the system
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (formError) {
          // A cancellation is not a form that failed to analyse. Recording
          // it as one would put a score-0 "Analysis failed: Scan cancelled"
          // entry in the report and carry on to the next form.
          if (isCancellation(formError)) {
            await this.finishCancelled(`after ${formsAnalyzed} of ${formsCount} forms`);

            return;
          }

          console.error(`❌ Error analyzing form ${i + 1}:`, formError);
          
          // Create a basic form analysis with error info
          const errorAnalysis = {
            formId: form.formId || `form_${i + 1}`,
            url: this.targetUrl,
            characteristics: form.characteristics || {},
            fields: form.fields || [],
            accessibility: {
              score: 0,
              issues: [`Analysis failed: ${formError.message}`],
              recommendations: ['Please try analyzing this form again']
            },
            error: formError.message
          };
          
          analyzedForms.push(errorAnalysis);
          formsAnalyzed++;
          
          // Still notify about completion (with error)
          this.updateProgress({
            type: 'form_analyzed',
            status: 'running',
            progress: Math.round(formProgress),
            currentStep: `Form ${i + 1} analysis failed, continuing...`,
            formData: {
              formId: form.formId,
              formIndex: i + 1,
              totalForms: formsCount,
              analysis: errorAnalysis,
              error: formError.message
            }
          });
        }
      }
      
      // Step 4: Generate final results
      this.updateProgress({
        status: 'running',
        progress: 95,
        currentStep: 'Generating final analysis report...'
      });
      
      const aiSummary = await this.generatePerFormSummary(analyzedForms, formsCount, formsAnalyzed);
      
      const results = {
        url: this.targetUrl,
        timestamp: new Date().toISOString(),
        jobId: this.jobId,
        forms: analyzedForms,
        summary: {
          totalForms: formsAnalyzed,
          totalFormsFound: formsCount,
          totalPages: 1,
          discoveredUrls: 1,
          visitedUrls: 1,
          coveragePercentage: 100,
          aiSummary: aiSummary,
          scanMode: 'per-form-analysis'
        },
        metadata: {
          targetUrl: this.targetUrl,
          analysisTime: Date.now() - this.scanStartTime,
          perFormMode: true,
          formsFound: formsCount,
          formsAnalyzed: formsAnalyzed,
          stoppedDueToLimit: this.stopRequested
        }
      };
      
      console.log(`\n🎉 === PER-FORM SCAN COMPLETED ===`);
      console.log(`📄 Page: ${this.targetUrl}`);
      console.log(`📝 Forms found: ${formsCount}`);
      console.log(`✅ Forms analyzed: ${formsAnalyzed}`);
      console.log(`⏰ Duration: ${((Date.now() - this.scanStartTime) / 1000).toFixed(1)}s`);
      
      this.updateProgress({
        status: this.stopRequested ? 'completed_with_errors' : 'completed',
        progress: 100,
        currentStep: this.stopRequested 
          ? `Analysis completed - ${formsAnalyzed} of ${formsCount} forms analyzed (usage limit reached)`
          : `Per-form analysis completed - all ${formsAnalyzed} forms analyzed`,
        results: results
      });
      
      this.isRunning = false;
      await this.tools.cleanup();
      
    } catch (error) {
      // Stopping on request is not a failure, and must not be reported as
      // one or rethrown -- the caller turns a rejection into status
      // 'failed', which would overwrite the cancellation.
      if (isCancellation(error)) {
        await this.finishCancelled();

        return;
      }

      console.error(`❌ Per-form scan failed:`, error);

      // `pageAccess` is attached when the target refused the request rather
      // than when anything of ours broke. Carried through so the interface
      // can say which, instead of offering advice about our API keys for a
      // site that simply would not let us in.
      this.updateProgress({
        status: 'failed',
        progress: 0,
        currentStep: error.pageAccess
          ? error.pageAccess.status
            ? `Could not read the page (HTTP ${error.pageAccess.status})`
            : 'Could not read the page'
          : 'Per-form scan failed',
        error: error.message,
        ...(error.pageAccess ? { errorKind: error.pageAccess.kind } : {})
      });
      
      this.isRunning = false;
      await this.tools.cleanup();
      throw error;
    }
  }
  
  /**
   * Analyze an individual form in detail using comprehensive analysis
   */
  /**
   * Scores one form. The selected model produces the scores, category issues
   * and recommendations; the deterministic analyser runs first and is handed
   * over as the fallback so a model failure degrades instead of breaking the
   * scan. Both the single-page and full-crawl paths go through here.
   *
   * When the form was captured, its crop is sent with the HTML so the model
   * can judge what markup cannot show. The bytes are read back out of the
   * screenshot store rather than threaded through the crawl, which keeps the
   * extracted-form payloads small.
   */
  async scoreForm({ formHtml, formId, fields, visualIndex, behaviour }) {
    const heuristicAnalysis = await this.tools.analyzeFormAccessibility(formHtml || '');
    const capture = Number.isInteger(visualIndex) ? getScreenshot(this.jobId, visualIndex) : null;

    return analyzeFormWithModel({
      provider: this.llm,
      formHtml,
      formId,
      url: this.targetUrl,
      fields,
      heuristicAnalysis,
      behaviour,
      screenshot: capture?.buffer ?? null,
      screenshotContentType: capture?.contentType ?? 'image/png',
      // So a cancel lands during the model call, which is where a scan
      // spends almost all of its time.
      signal: this.cancelController.signal,
      // The model refuses in patches that clear within a minute, so the
      // provider waits them out instead of degrading to the rule-based
      // score. That wait is silent otherwise: the progress bar holds at the
      // same percentage for up to a minute and the scan reads as hung.
      onRetry: ({ elapsedMs, budgetMs }) => {
        this.updateProgress({
          currentStep: this.describeModelWait({ elapsedMs, budgetMs })
        });
      }
    });
  }

  /**
   * Wording for the wait while the model is refusing.
   *
   * Says what is happening and that it is still working, without a count:
   * "attempt 14" sounds like something is badly wrong, when fourteen
   * attempts two seconds apart is the normal shape of a patch clearing.
   */
  describeModelWait({ elapsedMs, budgetMs }) {
    const remaining = Math.max(0, Math.ceil((budgetMs - elapsedMs) / 1000));

    return `Model is briefly unavailable - retrying for up to ${remaining}s...`;
  }

  async analyzeIndividualForm(formData) {
    console.log(`🔍 Analyzing individual form: ${formData.formId}`);
    
    try {
      // The model does the scoring; the heuristic is the fallback.
      const comprehensiveAnalysis = await this.scoreForm({
        formHtml: formData.formHtml || formData.html || '',
        formId: formData.formId,
        fields: formData.fields,
        visualIndex: formData.visual?.visualIndex,
        behaviour: formData.behaviour
      });
      
      // Create a detailed analysis result compatible with the existing system
      const analysis = {
        formId: formData.formId || `form_${Date.now()}`,
        url: this.targetUrl,
        characteristics: formData.characteristics || {},
        fields: formData.fields || [],
        accessibility: {
          score: comprehensiveAnalysis.score || 0,
          issues: comprehensiveAnalysis.issues || [],
          recommendations: comprehensiveAnalysis.recommendations || [],
          categories: comprehensiveAnalysis.categories || {},
          aiAccessibility: comprehensiveAnalysis.aiAccessibility || {},
          fieldAnalysis: comprehensiveAnalysis.fieldAnalysis || [],
          // Per-control findings that drive the visual overlay.
          fieldIssues: comprehensiveAnalysis.fieldIssues || [],
          // Findings about the form as a whole, which highlight no control.
          formFindings: comprehensiveAnalysis.formFindings || [],
          // 'model' or 'heuristic', so the report can say who scored this.
          analysisSource: comprehensiveAnalysis.analysisSource,
          // Which model actually answered, which is not always the one that
          // was asked for: the provider takes a stand-in when its preferred
          // model refuses. This object is rebuilt field by field, so an
          // addition to the analysis has to be listed here or the report
          // never sees it -- the badge read "scored by a model" with no name
          // on every single-page scan until this line existed. The full-crawl
          // path assigns the analysis wholesale and was unaffected.
          ...(comprehensiveAnalysis.analysisModel
            ? { analysisModel: comprehensiveAnalysis.analysisModel }
            : {}),
          // Whether the screenshot went with the HTML, so a reader can tell
          // whether a visual judgement was actually possible.
          visionUsed: comprehensiveAnalysis.visionUsed ?? false,
          ...(comprehensiveAnalysis.narrative ? { narrative: comprehensiveAnalysis.narrative } : {})
        }
      };
      
      // Add form-specific metadata
      analysis.metadata = {
        fieldCount: formData.fields?.length || 0,
        hasRequiredFields: formData.fields?.some(f => f.required) || false,
        hasLabels: comprehensiveAnalysis.aiAccessibility?.hasLabels || false,
        hasValidation: comprehensiveAnalysis.aiAccessibility?.hasValidation || false,
        hasCaptcha: comprehensiveAnalysis.aiAccessibility?.hasCaptcha || false,
        hasFileUpload: comprehensiveAnalysis.aiAccessibility?.hasFileUpload || false,
        analysisTimestamp: new Date().toISOString(),
        comprehensiveAnalysis: true
      };

      // Screenshot geometry for the visual overlay, if it was captured.
      if (formData.visual) {
        analysis.visual = formData.visual;
      }
      
      console.log(`✅ Comprehensive analysis complete for ${formData.formId}: ${analysis.accessibility.score}/100`);
      console.log(`   📊 Categories analyzed: ${Object.keys(analysis.accessibility.categories || {}).length}`);
      console.log(`   ⚠️  Issues found: ${analysis.accessibility.issues?.length || 0}`);
      console.log(`   💡 Recommendations: ${analysis.accessibility.recommendations?.length || 0}`);
      
      return analysis;
      
    } catch (error) {
      // The third catch between the model call and the scan loop, and the
      // one that made the first cancel attempt look like it had done nothing:
      // the cancellation arrived here, became a score-0 "analysis failed"
      // form, and the scan went on to publish a complete report.
      if (isCancellation(error)) {
        throw error;
      }

      console.error(`❌ Error in comprehensive form analysis:`, error);
      
      // Fallback to basic analysis if comprehensive fails
      const basicAnalysis = {
        formId: formData.formId || `form_${Date.now()}`,
        url: this.targetUrl,
        characteristics: formData.characteristics || {},
        fields: formData.fields || [],
        accessibility: {
          score: 0,
          issues: [`Comprehensive analysis failed: ${error.message}`],
          recommendations: ['Please try analyzing this form again'],
          categories: {},
          aiAccessibility: {},
          fieldAnalysis: []
        },
        metadata: {
          fieldCount: formData.fields?.length || 0,
          analysisTimestamp: new Date().toISOString(),
          comprehensiveAnalysis: false,
          error: error.message
        }
      };
      
      return basicAnalysis;
    }
  }
  
  /**
   * Generate AI summary for comprehensive per-form analysis
   */
  async generatePerFormSummary(analyzedForms, totalFound, totalAnalyzed) {
    try {
      const avgScore = analyzedForms.length > 0 
        ? Math.round(analyzedForms.reduce((sum, form) => sum + (form.accessibility?.score || 0), 0) / analyzedForms.length)
        : 0;
      
      const hasIssues = analyzedForms.some(form => form.accessibility?.issues?.length > 0);
      const stoppedEarly = totalAnalyzed < totalFound;
      
      // Calculate comprehensive metrics
      const formsWithCaptcha = analyzedForms.filter(form => form.accessibility?.aiAccessibility?.hasCaptcha).length;
      const formsWithLabels = analyzedForms.filter(form => form.accessibility?.aiAccessibility?.hasLabels).length;
      const formsWithValidation = analyzedForms.filter(form => form.accessibility?.aiAccessibility?.hasValidation).length;
      const aiCompatibleForms = analyzedForms.filter(form => (form.accessibility?.score || 0) >= 70).length;
      
      let summary = `Comprehensive per-form analysis of ${this.targetUrl} completed using 8-category AI compatibility assessment. `;
      
      if (stoppedEarly) {
        summary += `Found ${totalFound} forms but analyzed ${totalAnalyzed} due to usage limits. `;
      } else {
        summary += `Successfully analyzed all ${totalAnalyzed} forms found on the page. `;
      }
      
      summary += `Average AI compatibility score: ${avgScore}/100. `;
      
      // Detailed breakdown
      if (analyzedForms.length > 0) {
        summary += `AI Compatibility Breakdown: ${aiCompatibleForms}/${totalAnalyzed} forms are AI-friendly (70+ score). `;
        
        if (formsWithCaptcha > 0) {
          summary += `${formsWithCaptcha} forms have CAPTCHA (blocks AI agents). `;
        }
        
        if (formsWithLabels < totalAnalyzed) {
          summary += `${totalAnalyzed - formsWithLabels} forms lack proper labels. `;
        }
        
        if (formsWithValidation > 0) {
          summary += `${formsWithValidation} forms have validation (good for AI agents). `;
        }
      }
      
      if (hasIssues) {
        const totalIssues = analyzedForms.reduce((sum, form) => sum + (form.accessibility?.issues?.length || 0), 0);
        const totalRecommendations = analyzedForms.reduce((sum, form) => sum + (form.accessibility?.recommendations?.length || 0), 0);
        summary += `Identified ${totalIssues} issues with ${totalRecommendations} specific recommendations across all forms. `;
      } else {
        summary += `All analyzed forms show excellent AI compatibility with comprehensive 8-category analysis. `;
      }
      
      if (stoppedEarly) {
        summary += `Analysis stopped after ${totalAnalyzed} forms; ${totalFound - totalAnalyzed} forms were not analyzed. Raise SCAN_TIER to analyze more forms per scan.`;
      } else {
        summary += `All forms have been thoroughly analyzed across structural, identification, labeling, input hints, data types, validation, submission, and accessibility categories.`;
      }
      
      return summary;
      
    } catch (error) {
      console.error('Error generating comprehensive per-form summary:', error);
      return `Comprehensive per-form analysis completed with ${totalAnalyzed} forms analyzed out of ${totalFound} found using 8-category AI compatibility assessment.`;
    }
  }
  
  /**
   * Identify form issues for per-form analysis
   */
  identifyFormIssues(form) {
    const issues = [];
    
    if (form.characteristics?.hasCaptcha) {
      issues.push('CAPTCHA prevents automated form filling');
    }
    
    if (!form.fields?.some(f => f.label || f.ariaLabel)) {
      issues.push('Form lacks proper field labels');
    }
    
    if (!form.fields?.every(f => f.name)) {
      issues.push('Some fields missing name attributes');
    }
    
    if (form.characteristics?.hasFileUpload) {
      issues.push('File upload may require special handling');
    }
    
    if (!form.action && form.method?.toUpperCase() !== 'GET') {
      issues.push('Form action URL not specified');
    }
    
    return issues;
  }

  /**
   * Generate form recommendations based on issues
   */
  generateFormRecommendations(form, issues) {
    const recommendations = [];
    
    if (issues.includes('CAPTCHA prevents automated form filling')) {
      recommendations.push('Consider implementing alternative bot protection methods');
    }
    
    if (issues.includes('Form lacks proper field labels')) {
      recommendations.push('Add proper labels or ARIA labels to all form fields');
    }
    
    if (issues.includes('Some fields missing name attributes')) {
      recommendations.push('Ensure all form fields have unique name attributes');
    }
    
    if (issues.includes('File upload may require special handling')) {
      recommendations.push('Provide clear file type and size requirements');
    }
    
    if (issues.includes('Form action URL not specified')) {
      recommendations.push('Specify a clear form action URL for proper submission');
    }
    
    // Add general recommendations
    if (issues.length === 0) {
      recommendations.push('Form structure looks good for AI agent interaction');
    } else {
      recommendations.push('Address the identified issues to improve AI agent compatibility');
    }
    
    return recommendations;
  }

  /**
   * Calculate accessibility score based on form analysis
   */
  calculateAccessibilityScore(form, issues) {
    let score = 100;
    
    // Deduct points for each issue
    if (issues.includes('CAPTCHA prevents automated form filling')) score -= 40;
    if (issues.includes('Form lacks proper field labels')) score -= 30;
    if (issues.includes('Some fields missing name attributes')) score -= 20;
    if (issues.includes('File upload may require special handling')) score -= 10;
    if (issues.includes('Form action URL not specified')) score -= 15;
    
    // Bonus points for good practices
    if (form.fields?.every(f => f.name && (f.label || f.ariaLabel))) {
      score += 5; // Bonus for complete labeling
    }
    
    if (form.characteristics?.hasValidation) {
      score += 5; // Bonus for validation
    }
    
    // Ensure score is within bounds
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Stop processing due to usage limit
   */
  stopDueToUsageLimit() {
    console.log(`⚠️ Stopping per-form analysis due to usage limit reached`);
    this.stopRequested = true;
  }

  /**
   * Stop the scanning process (unchanged)
   */
  stop() {
    console.log(`🛑 Stopping agent ${this.jobId}`);
    this.isRunning = false;
    this.stopRequested = true;
    this.cancelController.abort();
  }

  /**
   * The user asked for this scan to stop.
   *
   * Distinct from `stopDueToUsageLimit`, which finishes the scan and keeps
   * what it has: that reports `completed_with_errors` with a partial report,
   * which is right when the limit decided to stop and wrong when the user
   * did. A cancelled scan publishes no report.
   */
  cancel() {
    console.log(`🛑 Scan cancelled by request: ${this.jobId}`);
    this.isRunning = false;
    this.cancelController.abort();
  }

  /**
   * Ends a cancelled scan: one final update, then release the browser.
   *
   * No results and no error. A cancelled scan has nothing to show, and
   * reporting it as failed would blame the tool for doing what it was told.
   * The browser matters here -- a cancelled scan that kept its Browserless
   * session would hold a paid slot until the socket timed out.
   */
  async finishCancelled(detail = '') {
    console.log(`🛑 Scan cancelled${detail ? ` ${detail}` : ''}: ${this.jobId}`);

    this.isRunning = false;

    this.updateProgress({
      status: 'cancelled',
      currentStep: `Scan cancelled${detail ? ` ${detail}` : ''}`,
      results: null
    });

    await this.cleanup();
  }

  /**
   * Clean up resources (unchanged)
   */
  async cleanup() {
    try {
      await this.tools.cleanup();
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  updateProgress(update) {
    /*
     * Nothing but the cancellation itself gets out once cancelled.
     *
     * Braces to the rethrows' belt. A cancellation has to survive every
     * catch between the model call and the scan loop, and there are four of
     * them; missing one let a cancelled scan publish a finished report with
     * a score. Rather than trusting that the list stays complete, the one
     * path every result must travel through refuses to carry anything but
     * the cancellation. A missed catch can now waste work, which is cheap,
     * instead of overwriting the user's decision, which is not.
     */
    if (this.isCancelled && update.status !== 'cancelled') {
      return;
    }

    // Add timestamp and additional context
    const enhancedUpdate = {
      ...update,
      timestamp: new Date().toISOString(),
      iteration: this.currentIteration,
      maxIterations: this.maxIterations,
      jobId: this.jobId
    };
    
    // Several updates change only the wording and leave the percentage where
    // it was. Printing "0%" for those made the log read as if the scan had
    // restarted, so the percentage is omitted when the update has none.
    if (update.currentStep) {
      const percent = Number.isFinite(Number(update.progress))
        ? `${Math.round(Number(update.progress))}% - `
        : '';

      console.log(`📈 Progress: ${percent}${update.currentStep}`);
    }
    
    if (this.progressCallback) {
      this.progressCallback(enhancedUpdate);
    }
  }
}
