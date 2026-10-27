import { AIAgent } from './agent.js';

/**
 * Improved AI Agent specifically for FULL CRAWL mode
 * Inherits from the original AIAgent to reuse the perfect single page analysis logic
 * 
 * Key improvements for full crawl:
 * 1. Systematic page discovery (not AI-driven)
 * 2. Individual form analysis with usage tracking (reused from single page)
 * 3. Real-time progress updates per form
 * 4. Proper usage limit enforcement
 * 5. Same UI output format as single page
 */
export class ImprovedFullCrawlAgent extends AIAgent {
  constructor(jobId, targetUrl, fullCrawl, scanTier, progressCallback) {
    // Initialize parent with single page mode to reuse its analysis logic
    super(jobId, targetUrl, false, scanTier, progressCallback);
    
    // Override for full crawl specific properties
    this.originalFullCrawl = fullCrawl;
    this.isFullCrawlMode = fullCrawl;
    
    // Full crawl specific properties
    this.discoveredPages = [];
    this.allFormsFromAllPages = [];
    this.currentPageIndex = 0;
    this.totalPagesScanned = 0;
    
    // Usage tracking (reuse parent's logic)
    this.usageLimits = {
      free: 5,
      basic: 50,
      pro: 200,
      premium: 1000
    };
  }

  /**
   * Get the per-scan form limit for the current scan tier
   */
  getUsageLimit() {
    return this.usageLimits[this.scanTier] || this.usageLimits.premium;
  }

  /**
   * Check if usage limit is reached
   */
  isUsageLimitReached() {
    return this.tools.formsAnalyzedCount >= this.getUsageLimit();
  }

  /**
   * Phase 1: Discover all pages systematically
   */
  async discoverAllPages() {
    console.log(`\n🕷️ === PHASE 1: SYSTEMATIC PAGE DISCOVERY ===`);
    
    this.updateProgress({
      status: 'running',
      progress: 5,
      currentStep: 'Discovering pages across the website...'
    });

    try {
      const discoveredPages = new Set();
      
      // Step 1: Add the target URL
      discoveredPages.add(this.targetUrl);
      
      // Step 2: Try to fetch sitemap.xml
      console.log(`📄 Attempting to fetch sitemap...`);
      try {
        const sitemapPages = await this.tools.fetchSitemap(this.targetUrl);
        if (sitemapPages && sitemapPages.length > 0) {
          console.log(`✅ Found ${sitemapPages.length} pages in sitemap`);
          sitemapPages.forEach(url => discoveredPages.add(url));
        } else {
          console.log(`ℹ️ No sitemap found or sitemap is empty`);
        }
      } catch (error) {
        console.log(`⚠️ Sitemap fetch failed: ${error.message}`);
      }

      // Step 3: Crawl homepage for additional links
      console.log(`🏠 Crawling homepage for additional links...`);
      try {
        const homepageResult = await this.tools.goToPage(this.targetUrl);
        const homepageLinks = homepageResult.links || [];
        
        if (homepageLinks && homepageLinks.length > 0) {
          console.log(`🔗 Found ${homepageLinks.length} links on homepage`);
          homepageLinks.forEach(url => discoveredPages.add(url));
        }
      } catch (error) {
        console.log(`⚠️ Homepage crawling failed: ${error.message}`);
      }

      // Convert to array and limit to reasonable number
      this.discoveredPages = Array.from(discoveredPages).slice(0, 50); // Limit to 50 pages max
      
      console.log(`🎯 Total pages discovered: ${this.discoveredPages.length}`);
      console.log(`📋 Pages to scan:`, this.discoveredPages.slice(0, 5).join(', ') + (this.discoveredPages.length > 5 ? '...' : ''));
      
      this.updateProgress({
        status: 'running',
        progress: 15,
        currentStep: `Discovered ${this.discoveredPages.length} pages. Starting form discovery...`
      });

      return this.discoveredPages;
      
    } catch (error) {
      console.error(`❌ Error during page discovery:`, error);
      // Fallback to single page
      this.discoveredPages = [this.targetUrl];
      console.log(`🔄 Falling back to single page analysis`);
      return this.discoveredPages;
    }
  }

  /**
   * Phase 2: Discover all forms across all pages
   */
  async discoverAllForms() {
    console.log(`\n📝 === PHASE 2: COMPREHENSIVE FORM DISCOVERY ===`);
    
    let totalFormsFound = 0;
    const pagesWithForms = [];
    const formsPerPage = [];

    for (let i = 0; i < this.discoveredPages.length; i++) {
      const pageUrl = this.discoveredPages[i];
      const progress = 15 + (i / this.discoveredPages.length) * 25; // 15-40%
      
      this.updateProgress({
        status: 'running',
        progress: Math.round(progress),
        currentStep: `Scanning page ${i + 1}/${this.discoveredPages.length} for forms...`
      });

      try {
        console.log(`🔍 [${i + 1}/${this.discoveredPages.length}] Scanning: ${pageUrl}`);
        
        // Load the page
        const pageResult = await this.tools.goToPage(pageUrl);
        
        // Extract forms from this page
        const pageForms = await this.tools.extractForms(pageResult.html);
        
        if (pageForms && pageForms.length > 0) {
          console.log(`✅ Found ${pageForms.length} forms on ${pageUrl}`);
          
          // Add page context to each form
          const formsWithContext = pageForms.map((form, formIndex) => ({
            ...form,
            pageUrl: pageUrl,
            pageTitle: this.tools.pageTitle || `Page ${i + 1}`,
            globalFormIndex: totalFormsFound + formIndex,
            pageIndex: i
          }));
          
          this.allFormsFromAllPages.push(...formsWithContext);
          totalFormsFound += pageForms.length;
          
          pagesWithForms.push({
            url: pageUrl,
            formsCount: pageForms.length,
            pageIndex: i
          });

          formsPerPage.push({
            pageUrl,
            forms: formsWithContext
          });
          
        } else {
          console.log(`ℹ️ No forms found on ${pageUrl}`);
        }
        
        this.totalPagesScanned++;
        
      } catch (error) {
        console.error(`❌ Error scanning ${pageUrl}:`, error.message);
        continue;
      }
    }

    console.log(`\n🎯 Form discovery complete:`);
    console.log(`   📊 Total forms found: ${totalFormsFound}`);
    console.log(`   📄 Pages scanned: ${this.totalPagesScanned}`);
    console.log(`   📝 Pages with forms: ${pagesWithForms.length}`);
    
    // Send forms discovered update
    this.updateProgress({
      type: 'forms_discovered',
      formsCount: totalFormsFound,
      pagesWithForms: pagesWithForms,
      totalPagesScanned: this.totalPagesScanned
    });

    return {
      allForms: this.allFormsFromAllPages,
      formsPerPage: formsPerPage,
      pagesWithForms: pagesWithForms
    };
  }

  /**
   * Phase 3: Analyze each form individually using parent's logic
   */
  async analyzeFormsIndividually() {
    console.log(`\n🤖 === PHASE 3: INDIVIDUAL FORM ANALYSIS ===`);
    
    const totalForms = this.allFormsFromAllPages.length;
    console.log(`📊 Starting individual analysis of ${totalForms} forms`);
    console.log(`🎯 Usage limit: ${this.getUsageLimit()} forms`);
    console.log(`👤 Scan tier: ${this.scanTier.toUpperCase()}`);

    // Reset forms analyzed counter to avoid carrying over from previous attempts
    this.tools.formsAnalyzedCount = 0;
    const analyzedForms = [];

    for (let i = 0; i < this.allFormsFromAllPages.length; i++) {
      // Check usage limit before analyzing each form
      if (this.isUsageLimitReached()) {
        console.log(`⚠️ Usage limit reached (${this.getUsageLimit()}). Stopping analysis.`);
        
        this.updateProgress({
          hitUsageLimit: true,
          formsAnalyzed: this.tools.formsAnalyzedCount,
          formsRemaining: totalForms - this.tools.formsAnalyzedCount
        });
        
        break;
      }

      const form = this.allFormsFromAllPages[i];
      const progress = 40 + (i / totalForms) * 50; // 40-90%
      
      this.updateProgress({
        status: 'running',
        progress: Math.round(progress),
        currentStep: `Analyzing form ${i + 1}/${totalForms} from ${form.pageUrl}...`
      });

      try {
        console.log(`🔍 [${i + 1}/${totalForms}] Analyzing form: ${form.formId} from ${form.pageUrl}`);
        
        // Model-scored, with the heuristic as fallback (see AIAgent.scoreForm).
        const analysis = await this.scoreForm({
          formHtml: form.formHtml,
          formId: form.formId,
          fields: form.fields
        });
        
        // Create analyzed form object
        const analyzedForm = {
          formId: form.formId,
          url: form.pageUrl,
          pageTitle: form.pageTitle,
          characteristics: form.characteristics,
          fields: form.fields,
          accessibility: analysis,
          analyzedAt: new Date().toISOString(),
          globalFormIndex: form.globalFormIndex
        };
        
        analyzedForms.push(analyzedForm);
        this.tools.formsAnalyzedCount++;
        
        console.log(`✅ Form analysis complete. Score: ${analysis.score}/${analysis.maxScore}`);
        
        // Send individual form analysis update
        this.updateProgress({
          type: 'form_analyzed',
          formData: {
            formIndex: i + 1,
            totalForms: totalForms,
            formId: form.formId,
            pageUrl: form.pageUrl,
            score: analysis.score,
            maxScore: analysis.maxScore
          },
          formsAnalyzed: this.tools.formsAnalyzedCount
        });
        
        // Small delay to prevent overwhelming the UI
        await new Promise(resolve => setTimeout(resolve, 300));
        
      } catch (error) {
        console.error(`❌ Error analyzing form ${form.formId}:`, error.message);
        
        // Still count as analyzed for usage tracking
        this.tools.formsAnalyzedCount++;
        
        // Add error form to results
        analyzedForms.push({
          formId: form.formId,
          url: form.pageUrl,
          pageTitle: form.pageTitle,
          characteristics: form.characteristics || {},
          fields: form.fields || [],
          accessibility: {
            score: 0,
            maxScore: 100,
            issues: [`Analysis failed: ${error.message}`],
            recommendations: ['Please try scanning this form again'],
            categories: {}
          },
          analyzedAt: new Date().toISOString(),
          analysisError: error.message,
          globalFormIndex: form.globalFormIndex
        });
      }
    }

    console.log(`\n🎯 Individual form analysis complete:`);
    console.log(`   ✅ Forms analyzed: ${this.tools.formsAnalyzedCount}`);
    console.log(`   📊 Forms with results: ${analyzedForms.length}`);
    console.log(`   ⚠️ Hit usage limit: ${this.isUsageLimitReached()}`);
    
    return analyzedForms;
  }

  /**
   * Generate final results in the same format as single-page scan
   */
  generateFullCrawlResults(analyzedForms) {
    const summary = {
      totalPages: this.totalPagesScanned,
      totalForms: this.allFormsFromAllPages.length,
      discoveredUrls: this.discoveredPages.length,
      visitedUrls: this.totalPagesScanned,
      coveragePercentage: Math.round((this.totalPagesScanned / this.discoveredPages.length) * 100),
      formsAnalyzed: this.tools.formsAnalyzedCount,
      hitUsageLimit: this.isUsageLimitReached()
    };

    // Generate AI summary using parent's logic
    const avgScore = analyzedForms.length > 0 
      ? Math.round(analyzedForms.reduce((sum, form) => sum + (form.accessibility?.score || 0), 0) / analyzedForms.length)
      : 0;

    const aiSummary = `Full website crawl completed. Discovered ${this.discoveredPages.length} pages, scanned ${this.totalPagesScanned} pages, and analyzed ${this.tools.formsAnalyzedCount} forms with an average AI compatibility score of ${avgScore}/100.`;

    return {
      success: true,
      scanType: 'full-crawl',
      results: {
        summary: summary,
        forms: analyzedForms,
        aiSummary: aiSummary,
        scanMode: 'full-crawl',
        targetUrl: this.targetUrl,
        usageInfo: {
          formsAnalyzed: this.tools.formsAnalyzedCount,
          usageLimit: this.getUsageLimit(),
          hitLimit: this.isUsageLimitReached(),
          scanTier: this.scanTier
        },
        crawlInfo: {
          pagesDiscovered: this.discoveredPages.length,
          pagesScanned: this.totalPagesScanned,
          formsFound: this.allFormsFromAllPages.length
        }
      }
    };
  }

  /**
   * Main scan method - orchestrates all phases for full crawl
   */
  async startScan() {
    if (!this.isFullCrawlMode) {
      // If not full crawl, delegate to parent's single page analysis
      console.log(`📄 Delegating to single page analysis...`);
      return await super.startScan();
    }

    console.log(`\n🚀 === STARTING IMPROVED FULL CRAWL ===`);
    console.log(`🆔 Job ID: ${this.jobId}`);
    console.log(`🌐 Target URL: ${this.targetUrl}`);
    console.log(`🎯 Mode: FULL WEBSITE CRAWL (Improved)`);
    console.log(`👤 Scan tier: ${this.scanTier.toUpperCase()}`);
    console.log(`📊 Usage Limit: ${this.getUsageLimit()} forms`);
    console.log(`⏰ Started at: ${new Date().toLocaleString()}`);

    this.isRunning = true;
    this.scanStartTime = Date.now();

    try {
      // Phase 1: Discover all pages systematically
      await this.discoverAllPages();
      
      // Phase 2: Find all forms across all pages
      await this.discoverAllForms();
      
      // Phase 3: Analyze forms individually (reusing parent's logic)
      const analyzedForms = await this.analyzeFormsIndividually();

      // Generate final results
      const results = this.generateFullCrawlResults(analyzedForms);
      
      this.updateProgress({
        status: 'completed',
        progress: 100,
        currentStep: `Full crawl completed! Analyzed ${this.tools.formsAnalyzedCount} forms across ${this.totalPagesScanned} pages.`,
        results: results.results
      });

      const duration = ((Date.now() - this.scanStartTime) / 1000).toFixed(1);
      console.log(`\n✅ === FULL CRAWL COMPLETED ===`);
      console.log(`🌐 Pages discovered: ${this.discoveredPages.length}`);
      console.log(`📄 Pages scanned: ${this.totalPagesScanned}`);
      console.log(`📝 Forms found: ${this.allFormsFromAllPages.length}`);
      console.log(`🤖 Forms analyzed: ${this.tools.formsAnalyzedCount}`);
      console.log(`⏰ Duration: ${duration}s`);
      console.log(`🎯 Average score: ${analyzedForms.length > 0 ? Math.round(analyzedForms.reduce((sum, form) => sum + (form.accessibility?.score || 0), 0) / analyzedForms.length) : 0}/100`);

      return results;

    } catch (error) {
      console.error(`❌ Full crawl failed:`, error);
      
      this.updateProgress({
        status: 'failed',
        progress: 0,
        currentStep: `Full crawl failed: ${error.message}`,
        error: error.message
      });

      throw error;
    } finally {
      this.isRunning = false;
    }
  }
}
