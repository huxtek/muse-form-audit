import puppeteer from 'puppeteer-core';
import * as cheerio from 'cheerio';
import xml2js from 'xml2js';
import {
  captureFormVisuals,
  capturePageMap,
  expandViewportToPage,
  readFormGeometry
} from './lib/visuals/captureFormVisuals.js';
import { PROBE_ENABLED, probeFormBehaviour } from './lib/analysis/probeFormBehaviour.js';

/**
 * AI Tools for comprehensive website crawling and form analysis
 * These functions are called by the OpenAI agent to perform site scanning
 */

/**
 * Strip a secret out of text before it reaches a log or an API response.
 * Browser connection errors routinely echo back the full WebSocket endpoint,
 * which carries the token as a query parameter.
 */
function redactToken(text, token) {
  const message = String(text ?? '');
  if (!token) return message;

  return message.split(token).join('[REDACTED]').replace(/token=[^&\s"']+/gi, 'token=[REDACTED]');
}

/**
 * Message for a real scan attempted without credentials. Names every missing
 * key at once, so a first-time cloner does not fix one and then discover the
 * other, and points at Dev Mode as the no-key alternative. Reports only the
 * keys that are actually absent, and never echoes a key value.
 */
export function missingCredentialsMessage() {
  // A model key can come from either provider, so report the model requirement
  // as satisfied if at least one is present.
  const hasModelKey = Boolean(process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY);
  const hasBrowser = Boolean(process.env.BROWSERLESS_TOKEN);

  const missing = [];
  if (!hasModelKey) missing.push('a model key (MODEL_API_KEY for Muse, or OPENAI_API_KEY for OpenAI)');
  if (!hasBrowser) missing.push('BROWSERLESS_TOKEN');

  let subject;
  if (missing.length === 2) {
    subject = 'neither is set';
  } else if (missing.length === 1) {
    subject = `${missing[0]} is missing`;
  } else {
    subject = 'both are set';
  }

  return (
    `Real scans need a model key and BROWSERLESS_TOKEN, but ${subject}. ` +
    'Add the missing value(s) to .env (free Browserless token at https://browserless.io), ' +
    'or turn on Dev Mode in the UI to run the full flow on mock data with no keys.'
  );
}

export class CrawlerTools {
  constructor() {
    this.browser = null;
    this.context = null;
    this.discovered = new Set();
    this.visited = new Set();
    this.baseUrl = null;
    this.baseDomain = null;
    this.forms = [];
    this.networkLogs = [];
  }

  /**
   * Initialize browser using Browserless.io cloud service
   */
  async initBrowser() {
    if (!this.browser) {
      const browserlessToken = process.env.BROWSERLESS_TOKEN;

      // Checked outside the try so the credential guidance is not rewritten by
      // the connection-error branches below.
      if (!browserlessToken) {
        console.error('❌ [TOOLS] BROWSERLESS_TOKEN environment variable is required');
        throw new Error(missingCredentialsMessage());
      }

      try {
        console.log('🚀 [TOOLS] Connecting to Browserless.io cloud browser...');

        // Connect to Browserless.io cloud Chrome
        console.log('🌐 [TOOLS] Attempting connection to wss://production-sfo.browserless.io...');
        this.browser = await puppeteer.connect({
          browserWSEndpoint: `wss://production-sfo.browserless.io?token=${browserlessToken}`,
          timeout: 30000
        });

        console.log('✅ [TOOLS] Connected to Browserless.io successfully');

      } catch (error) {
        // Connection errors frequently echo the WebSocket endpoint back, which
        // contains the token as a query parameter. Redact before logging.
        const safeMessage = redactToken(error.message, browserlessToken);
        console.error('❌ [TOOLS] Failed to connect to Browserless.io:', safeMessage);

        if (safeMessage.includes('WebSocket')) {
          throw new Error('Failed to connect to Browserless.io. Please check your internet connection and token validity.');
        } else {
          throw new Error(`Browserless.io connection failed: ${safeMessage}`);
        }
      }
    } else {
      console.log('♻️  [TOOLS] Browser already initialized, reusing connection');
    }
  }

  /**
   * Releases the remote browser.
   *
   * `close()` rather than `disconnect()` on purpose: disconnecting leaves the
   * Browserless session running until it times out on their side, holding a
   * paid slot for a scan that has finished. Closing ends the session.
   *
   * This class used to declare `cleanup` twice. JavaScript keeps the later
   * definition, so the earlier one -- which disconnected and logged that it
   * had -- was dead code, and its missing log line made it impossible to
   * tell from the logs whether a scan had released its browser at all.
   */
  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('✅ [TOOLS] Browserless session closed');
    }
  }

  /**
   * Extract domain from URL for same-domain filtering
   */
  extractDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  /**
   * Check if URL is same domain
   */
  isSameDomain(url) {
    const domain = this.extractDomain(url);
    return domain === this.baseDomain;
  }

  /**
   * Normalize URL (remove fragments, add protocol if missing)
   */
  normalizeUrl(url, baseUrl) {
    try {
      const normalized = new URL(url, baseUrl);
      normalized.hash = ''; // Remove fragment
      return normalized.href;
    } catch {
      return null;
    }
  }

  /**
   * Tool: fetchSitemap
   * Fetches /sitemap.xml and returns an array of URLs
   */
  async fetchSitemap(baseUrl) {
    try {
      console.log(`🗺️  Fetching sitemap for: ${baseUrl}`);
      
      this.baseUrl = baseUrl;
      this.baseDomain = this.extractDomain(baseUrl);
      
      const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
      
      await this.initBrowser();
      const page = await this.browser.newPage();
      
      try {
        const response = await page.goto(sitemapUrl, { 
          waitUntil: 'networkidle0',
          timeout: 30000 
        });
        
        if (!response || response.status() !== 200) {
          throw new Error(`Sitemap not found (HTTP ${response?.status()})`);
        }
        
        const content = await page.content();
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(content);
        
        const urls = [];
        
        // Handle standard sitemap format
        if (result.urlset && result.urlset.url) {
          for (const urlEntry of result.urlset.url) {
            if (urlEntry.loc && urlEntry.loc[0]) {
              const url = urlEntry.loc[0];
              if (this.isSameDomain(url)) {
                urls.push(url);
                this.discovered.add(url);
              }
            }
          }
        }
        
        // Handle sitemap index format
        if (result.sitemapindex && result.sitemapindex.sitemap) {
          for (const sitemapEntry of result.sitemapindex.sitemap) {
            if (sitemapEntry.loc && sitemapEntry.loc[0]) {
              // Recursively fetch sub-sitemaps
              const subUrls = await this.fetchSitemap(sitemapEntry.loc[0]);
              urls.push(...subUrls);
            }
          }
        }
        
        await page.close();
        
        console.log(`📋 Found ${urls.length} URLs in sitemap`);
        return urls;
        
      } catch (error) {
        await page.close();
        console.log(`❌ Sitemap not available: ${error.message}`);
        
        // Fallback: add base URL to discovered
        this.discovered.add(baseUrl);
        return [baseUrl];
      }
      
    } catch (error) {
      console.error('Sitemap fetch error:', error);
      this.discovered.add(baseUrl);
      return [baseUrl];
    }
  }

  /**
   * Truncate HTML content to reduce token usage while preserving form information
   * Fixed to prevent JSON parsing errors - more aggressive truncation
   */
  truncateHtmlForAnalysis(html) {
    // If HTML is small, return as-is
    if (html.length < 5000) { // Reduced from 20000
      return html;
    }
    
    const $ = cheerio.load(html);
    
    // Remove large script and style blocks
    $('script').remove();
    $('style').remove();
    
    // Keep only essential elements for form analysis
    const essentialContent = $('form, input, textarea, select, button, label, main, article, section').parent().html() || '';
    
    // If we have essential content, use that
    if (essentialContent && essentialContent.length > 0) {
      // Safely truncate without breaking JSON strings
      const truncated = this.safeTruncate(essentialContent, 5000); // Reduced from 15000
      return truncated;
    }
    
    // Otherwise, safely truncate the full HTML
    return this.safeTruncate(html, 5000); // Reduced from 15000
  }

  /**
   * Safely truncate text without breaking JSON strings or HTML tags
   */
  safeTruncate(text, maxLength) {
    if (text.length <= maxLength) {
      return text;
    }
    
    // Find a safe truncation point (avoid breaking in the middle of quotes or tags)
    let truncateAt = maxLength;
    
    // Look backwards for a safe break point
    for (let i = maxLength; i > maxLength - 200 && i > 0; i--) {
      const char = text[i];
      const prevChar = text[i - 1];
      
      // Safe break points: after closing tags, after spaces, after punctuation
      if ((char === '>' && prevChar !== '/') || 
          (char === ' ' && prevChar !== '\\') ||
          (char === '\n') ||
          (char === '.' && prevChar !== '\\')) {
        truncateAt = i;
        break;
      }
    }
    
    const truncated = text.substring(0, truncateAt);
    
    // Ensure we don't have unclosed quotes that could break JSON
    const quoteCount = (truncated.match(/"/g) || []).length;
    const singleQuoteCount = (truncated.match(/'/g) || []).length;
    
    // If we have an odd number of quotes, we might have broken a string
    // Add a note instead of risking JSON parsing errors
    if (quoteCount % 2 !== 0 || singleQuoteCount % 2 !== 0) {
      return truncated + '...[content truncated for analysis]';
    }
    
    return truncated + '...[truncated for analysis]';
  }

  /**
   * Tool: goToPage
   * Navigates to a URL using Playwright and returns { html, links } with optimized content
   */
  async goToPage(url) {
    try {
      console.log(`🌐 [TOOLS] Navigating to: ${url}`);
      
      console.log('🔧 [TOOLS] Initializing browser...');
      await this.initBrowser();
      
      if (!this.browser) {
        console.error('❌ [TOOLS] Browser initialization failed - browser is null');
        throw new Error('Browser initialization failed');
      }
      
      console.log('📄 [TOOLS] Creating new page...');
      const page = await this.browser.newPage();
      
      // Set viewport and user agent
      console.log('⚙️  [TOOLS] Setting viewport and user agent...');
      await page.setViewport({ width: 1280, height: 720 });
      await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Enable network logging
      const networkLog = [];
      page.on('response', (response) => {
        networkLog.push({
          url: response.url(),
          status: response.status(),
          contentType: response.headers()['content-type']
        });
      });
      
      try {
        console.log(`🚀 [TOOLS] Loading page: ${url}`);
        const response = await page.goto(url, { 
          waitUntil: 'networkidle0',
          timeout: 30000 
        });
        
        if (!response) {
          console.error('❌ [TOOLS] Failed to load page - no response');
          throw new Error('Failed to load page');
        }
        
        const status = response.status();
        const finalUrl = response.url();
        console.log(`📊 [TOOLS] Page loaded with status: ${status}`);
        console.log(`📊 [TOOLS] Final URL: ${finalUrl}`);
        
        // Wait for any dynamic content
        console.log('⏳ [TOOLS] Waiting for dynamic content...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Get FULL HTML content - no truncation for GPT-5
        console.log('📝 [TOOLS] Getting page content...');
        const html = await page.content();
        
        console.log(`📄 [TOOLS] Full HTML captured: ${html.length} characters (NO TRUNCATION)`);
        
        // Debug: Check if we got actual HTML content
        const hasFormsInHtml = html.includes('<form');
        const hasInputsInHtml = html.includes('<input');
        const hasHtmlTag = html.includes('<html');
        const hasBodyTag = html.includes('<body');
        console.log(`🔍 [TOOLS] HTML content check: html=${hasHtmlTag}, body=${hasBodyTag}, forms=${hasFormsInHtml}, inputs=${hasInputsInHtml}`);
        
        // Log first 1000 characters for debugging
        console.log(`🔍 [TOOLS] HTML preview: ${html.substring(0, 1000)}...`);
        
        // Check for forms before extracting links
        console.log('📋 [TOOLS] Checking for forms...');
        const formCount = await page.evaluate(() => {
          return document.querySelectorAll('form').length;
        });
        console.log(`📋 [TOOLS] Found ${formCount} forms on page`);
        
        // Extract all links
        console.log('🔗 [TOOLS] Extracting links...');
        const links = await page.evaluate(() => {
          const linkElements = document.querySelectorAll('a[href]');
          return Array.from(linkElements).map(link => link.href);
        });
        
        // Filter and normalize links (increased limit for better coverage)
        const sameOriginLinks = links
          .map(link => this.normalizeUrl(link, url))
          .filter(link => link && this.isSameDomain(link))
          .filter(link => !this.visited.has(link))
          .slice(0, 100); // Increased from 50 to 100
        
        // Add new links to discovered
        sameOriginLinks.forEach(link => this.discovered.add(link));
        
        // Mark current URL as visited
        this.visited.add(url);

        // Screenshots and geometry, while the page is still open. Cheerio
        // cannot supply coordinates, so this is the only chance. Geometry is
        // read once and shared between the form crops and the page map.
        // What the markup cannot show: declared constraints, the regions
        // waiting to announce an error, and what the browser says when those
        // constraints are checked. Nothing is submitted.
        let formBehaviour = [];
        if (PROBE_ENABLED) {
          formBehaviour = await probeFormBehaviour(page);
        }

        let formVisuals = [];
        let pageMap = null;
        try {
          // Grow the viewport to cover the page FIRST. Chrome only paints a
          // screenshot correctly when it is unclipped, so every capture below
          // is a plain viewport shot -- which means the viewport has to be
          // the page. Geometry is read afterwards because the resize reflows
          // a responsive layout.
          const restoreViewport = await expandViewportToPage(page);
          try {
            const geometry = await readFormGeometry(page);
            formVisuals = await captureFormVisuals(page, { geometry });
            if (geometry.forms.length > 0) {
              pageMap = await capturePageMap(page, { pageSize: geometry.pageSize });
            }
          } finally {
            await restoreViewport();
          }
        } catch (visualError) {
          // A visual failure must never fail the scan; the written findings
          // are the product, the pictures are an aid.
          console.warn(`⚠️  [VISUALS] Capture skipped: ${visualError.message}`);
        }

        await page.close();
        
        console.log(`✅ Page loaded successfully - FULL content preserved`);
        console.log(`   📄 HTML size: ${html.length} characters (NO TRUNCATION)`);
        console.log(`   🔗 Links found: ${sameOriginLinks.length}`);
        console.log(`   📊 HTTP status: ${response.status()}`);
        
        if (sameOriginLinks.length > 0) {
          console.log(`   🔗 Sample links: ${sameOriginLinks.slice(0, 3).join(', ')}${sameOriginLinks.length > 3 ? '...' : ''}`);
        }
        
        return {
          html, // FULL HTML - no truncation
          links: sameOriginLinks,
          networkLog,
          status: response.status(),
          fullContentPreserved: true,
          originalSize: html.length,
          formVisuals,
          formBehaviour,
          pageMap
        };
        
      } catch (error) {
        await page.close();
        throw error;
      }
      
    } catch (error) {
      console.error(`Navigation error for ${url}:`, error);
      this.visited.add(url); // Mark as visited even if failed
      return {
        html: '',
        links: [],
        networkLog: [],
        error: error.message
      };
    }
  }

  /**
   * Tool: extractForms
   * Parses HTML and returns an array of form objects
   */
  async extractForms(html) {
    try {
      console.log('🔍 [TOOLS] Extracting forms from HTML...');
      console.log(`📄 [TOOLS] HTML content length: ${html.length} characters`);
      
      // Debug: Log first 1000 characters of HTML
      console.log(`🔍 [TOOLS] HTML preview: ${html.substring(0, 1000)}...`);
      
      const $ = cheerio.load(html);
      const forms = [];
      
      // Check if HTML was loaded properly
      const totalElements = $('*').length;
      console.log(`🔍 [TOOLS] Parsed ${totalElements} HTML elements`);
      
      // Check for forms specifically
      const formElements = $('form');
      console.log(`📋 [TOOLS] Found ${formElements.length} <form> elements`);
      
      if (formElements.length === 0) {
        console.log('⚠️  [TOOLS] No <form> elements found in HTML');
        console.log('🔍 [TOOLS] Checking for form-like structures...');
        
        // Check for inputs without forms
        const inputsWithoutForm = $('input, textarea, select').not('form input, form textarea, form select');
        console.log(`🔍 [TOOLS] Found ${inputsWithoutForm.length} form fields outside <form> tags`);
        
        // Log a sample of the HTML for debugging
        const htmlSample = html.substring(0, 1500);
        console.log(`📝 [TOOLS] HTML sample: ${htmlSample}...`);
        
        // Check if this looks like a valid HTML document
        const hasHtmlTag = html.includes('<html');
        const hasBodyTag = html.includes('<body');
        const hasTitle = html.includes('<title');
        console.log(`🔍 [TOOLS] HTML structure check: html=${hasHtmlTag}, body=${hasBodyTag}, title=${hasTitle}`);
      }
      
      $('form').each((index, formElement) => {
        console.log(`📋 [TOOLS] Processing form ${index + 1}...`);
        
        const $form = $(formElement);
        const formId = $form.attr('id') || `form-${index}`;
        const action = $form.attr('action') || '';
        const method = ($form.attr('method') || 'GET').toUpperCase();
        const formHtml = $.html($form);
        
        console.log(`📋 [TOOLS] Form ${index + 1}: id="${formId}", action="${action}", method="${method}"`);
        
        // Extract form fields
        const fields = [];
        const fieldElements = $form.find('input, textarea, select, button[type="submit"]');
        console.log(`🔍 [TOOLS] Form ${index + 1} has ${fieldElements.length} fields`);
        
        $form.find('input, textarea, select, button[type="submit"]').each((fieldIndex, fieldElement) => {
          const $field = $(fieldElement);
          const field = {
            id: $field.attr('id') || `field-${fieldIndex}`,
            name: $field.attr('name') || '',
            type: $field.attr('type') || fieldElement.tagName.toLowerCase(),
            placeholder: $field.attr('placeholder') || '',
            required: $field.prop('required') || false,
            disabled: $field.prop('disabled') || false,
            value: $field.val() || '',
            ariaLabel: $field.attr('aria-label') || '',
            label: this.findFieldLabel($, $field),
            options: this.extractSelectOptions($, $field)
          };
          fields.push(field);
          console.log(`  🔍 [TOOLS] Field ${fieldIndex + 1}: name="${field.name}", type="${field.type}", label="${field.label}"`);
        });
        
        // Detect form characteristics
        const characteristics = {
          hasCaptcha: this.detectCaptcha($form, $),
          hasFileUpload: $form.find('input[type="file"]').length > 0,
          hasMultiStep: this.detectMultiStep($form, $),
          hasValidation: this.detectValidation($form, $),
          isLoginForm: this.detectLoginForm($form, $),
          isContactForm: this.detectContactForm($form, $),
          isSearchForm: this.detectSearchForm($form, $)
        };
        
        console.log(`📊 [TOOLS] Form ${index + 1} characteristics:`, characteristics);
        
        forms.push({
          formId,
          action,
          method,
          formHtml,
          fields,
          characteristics,
          url: this.baseUrl // Add context of where form was found
        });
      });
      
      this.forms.push(...forms);
      console.log(`✅ [TOOLS] Extracted ${forms.length} forms successfully`);
      
      return forms;
      
    } catch (error) {
      console.error('Form extraction error:', error);
      return [];
    }
  }

  /**
   * Helper: Find label for a form field
   */
  findFieldLabel($, $field) {
    const fieldId = $field.attr('id');
    if (fieldId) {
      const $label = $(`label[for="${fieldId}"]`);
      if ($label.length) {
        return $label.text().trim();
      }
    }
    
    // Check for parent label
    const $parentLabel = $field.closest('label');
    if ($parentLabel.length) {
      return $parentLabel.text().trim();
    }
    
    return '';
  }

  /**
   * Helper: Extract select options
   */
  extractSelectOptions($, $field) {
    if ($field.is('select')) {
      const options = [];
      $field.find('option').each((i, option) => {
        const $option = $(option);
        options.push({
          value: $option.attr('value') || '',
          text: $option.text().trim()
        });
      });
      return options;
    }
    return [];
  }

  /**
   * Helper: Detect CAPTCHA
   */
  detectCaptcha($form, $) {
    const captchaSelectors = [
      '.g-recaptcha',
      '.h-captcha',
      '[data-sitekey]',
      'input[name*="captcha"]',
      '.captcha'
    ];
    
    return captchaSelectors.some(selector => $form.find(selector).length > 0);
  }

  /**
   * Helper: Detect multi-step form
   */
  detectMultiStep($form, $) {
    const stepSelectors = [
      '.step',
      '.stage',
      '[data-step]',
      '.wizard',
      '.progress'
    ];
    
    return stepSelectors.some(selector => $form.find(selector).length > 0);
  }

  /**
   * Helper: Detect validation
   */
  detectValidation($form, $) {
    return $form.find('[required], [pattern], [data-validate]').length > 0;
  }

  /**
   * Helper: Detect login form
   */
  detectLoginForm($form, $) {
    const hasPassword = $form.find('input[type="password"]').length > 0;
    const hasEmail = $form.find('input[type="email"], input[name*="email"], input[name*="username"]').length > 0;
    return hasPassword && hasEmail;
  }

  /**
   * Helper: Detect contact form
   */
  detectContactForm($form, $) {
    // Check field names
    const fieldNames = $form.find('input, textarea').map((i, el) => $(el).attr('name') || '').get().join(' ').toLowerCase();
    const nameMatches = ['name', 'email', 'message', 'subject', 'phone'].filter(field => fieldNames.includes(field)).length;
    
    // Check field labels
    const fieldLabels = $form.find('label, input, textarea').map((i, el) => {
      const $el = $(el);
      return ($el.text() || $el.attr('placeholder') || $el.attr('aria-label') || '').toLowerCase();
    }).get().join(' ');
    
    const labelMatches = ['name', 'email', 'message', 'comment', 'subject', 'phone', 'contact'].filter(field => fieldLabels.includes(field)).length;
    
    // Check field types
    const hasEmailField = $form.find('input[type="email"]').length > 0;
    const hasTextarea = $form.find('textarea').length > 0;
    const hasPhoneField = $form.find('input[type="tel"]').length > 0;
    
    // It's a contact form if:
    // - Has at least 2 name matches OR
    // - Has at least 3 label matches OR  
    // - Has email field + textarea (common contact form pattern)
    return nameMatches >= 2 || labelMatches >= 3 || (hasEmailField && hasTextarea);
  }

  /**
   * Helper: Detect search form
   */
  detectSearchForm($form, $) {
    const searchFields = $form.find('input[type="search"], input[name*="search"], input[name*="query"], input[name*="q"]');
    return searchFields.length > 0;
  }

  /**
   * Tool: fillForm
   * Attempts to fill and submit a form with realistic dummy data
   */
  async fillForm(formHtml, formUrl) {
    try {
      console.log('📝 Attempting to fill form...');
      
      await this.initBrowser();
      const page = await this.browser.newPage();
      
      // Navigate to the page containing the form
      await page.goto(formUrl, { waitUntil: 'networkidle0' });
      
      // Parse form to understand fields
      const $ = cheerio.load(formHtml);
      const formSelector = 'form';
      
      const fillResults = {
        success: false,
        filledFields: [],
        validationErrors: [],
        responseHtml: '',
        networkLogs: [],
        error: null
      };
      
      // Network logging
      page.on('response', (response) => {
        fillResults.networkLogs.push({
          url: response.url(),
          status: response.status(),
          method: response.request().method()
        });
      });
      
      try {
        // Fill form fields with realistic data
        const fields = [];
        $(formHtml).find('input, textarea, select').each((i, el) => {
          const $el = $(el);
          fields.push({
            name: $el.attr('name'),
            type: $el.attr('type') || el.tagName.toLowerCase(),
            id: $el.attr('id'),
            required: $el.prop('required')
          });
        });
        
        for (const field of fields) {
          if (!field.name) continue;
          
          const selector = field.id ? `#${field.id}` : `[name="${field.name}"]`;
          
          try {
            const element = await page.$(selector);
            if (!element) continue;
            
            const dummyValue = this.generateDummyValue(field);
            
            if (field.type === 'select') {
              await page.select(selector, '1'); // Select first option
            } else if (field.type === 'checkbox' || field.type === 'radio') {
              await page.click(selector);
            } else if (field.type !== 'submit' && field.type !== 'button') {
              await page.type(selector, dummyValue);
            }
            
            fillResults.filledFields.push({
              name: field.name,
              type: field.type,
              value: dummyValue
            });
            
          } catch (fieldError) {
            console.log(`Could not fill field ${field.name}:`, fieldError.message);
          }
        }
        
        // Attempt to submit (but don't actually submit to avoid spam)
        // Instead, just validate the form
        const validationResult = await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) {
            return form.checkValidity();
          }
          return false;
        });
        
        fillResults.success = validationResult;
        fillResults.responseHtml = await page.content();
        
        await page.close();
        
        console.log(`✅ Form fill attempt completed. Success: ${fillResults.success}`);
        return fillResults;
        
      } catch (error) {
        await page.close();
        fillResults.error = error.message;
        return fillResults;
      }
      
    } catch (error) {
      console.error('Form filling error:', error);
      return {
        success: false,
        filledFields: [],
        validationErrors: [],
        responseHtml: '',
        networkLogs: [],
        error: error.message
      };
    }
  }

  /**
   * Generate realistic dummy data for form fields
   */
  generateDummyValue(field) {
    const { name, type } = field;
    const nameLC = (name || '').toLowerCase();
    
    // Email fields
    if (type === 'email' || nameLC.includes('email')) {
      return 'test@example.com';
    }
    
    // Name fields
    if (nameLC.includes('name') || nameLC.includes('first') || nameLC.includes('last')) {
      return nameLC.includes('first') ? 'John' : nameLC.includes('last') ? 'Doe' : 'John Doe';
    }
    
    // Phone fields
    if (type === 'tel' || nameLC.includes('phone') || nameLC.includes('tel')) {
      return '+1-555-123-4567';
    }
    
    // Password fields
    if (type === 'password') {
      return 'TestPassword123!';
    }
    
    // Number fields
    if (type === 'number') {
      return '123';
    }
    
    // Date fields
    if (type === 'date') {
      return '2024-01-15';
    }
    
    // URL fields
    if (type === 'url') {
      return 'https://example.com';
    }
    
    // Message/comment fields
    if (nameLC.includes('message') || nameLC.includes('comment') || nameLC.includes('description')) {
      return 'This is a test message for form validation purposes.';
    }
    
    // Default text
    return 'Test Value';
  }

  /**
   * Tool: analyzeFormAccessibility
   * Analyzes form HTML for AI-friendliness and accessibility
   */
  async analyzeFormAccessibility(formHtml) {
    try {
      console.log('🔍 Performing comprehensive AI agent compatibility analysis...');
      
      const $ = cheerio.load(formHtml);
      const $form = $('form');
      
      const analysis = {
        score: 0,
        maxScore: 100,
        issues: [],
        recommendations: [],
        categories: {
          structural: { score: 0, maxScore: 15, issues: [] },
          identification: { score: 0, maxScore: 20, issues: [] },
          labeling: { score: 0, maxScore: 15, issues: [] },
          inputHints: { score: 0, maxScore: 10, issues: [] },
          dataTypes: { score: 0, maxScore: 15, issues: [] },
          validation: { score: 0, maxScore: 10, issues: [] },
          submission: { score: 0, maxScore: 10, issues: [] },
          accessibility: { score: 0, maxScore: 5, issues: [] }
        },
        aiAccessibility: {
          hasLabels: false,
          hasAriaLabels: false,
          hasNameAttributes: false,
          hasValidation: false,
          hasCaptcha: false,
          hasFileUpload: false,
          hasProperStructure: false,
          hasAutocomplete: false,
          hasDataTypes: false
        },
        fieldAnalysis: []
      };

      // 1. STRUCTURAL & NAVIGATIONAL ANALYSIS
      await this.analyzeStructuralFactors($, $form, analysis);
      
      // 2. IDENTIFICATION & TARGETING ANALYSIS
      await this.analyzeIdentificationFactors($, $form, analysis);
      
      // 3. LABELING & SEMANTICS ANALYSIS
      await this.analyzeLabelingFactors($, $form, analysis);
      
      // 4. INPUT HINTS & AUTOCOMPLETE ANALYSIS
      await this.analyzeInputHints($, $form, analysis);
      
      // 5. DATA TYPES & CONSTRAINTS ANALYSIS
      await this.analyzeDataTypes($, $form, analysis);
      
      // 6. VALIDATION & FEEDBACK ANALYSIS
      await this.analyzeValidation($, $form, analysis);
      
      // 7. SUBMISSION HANDLING ANALYSIS
      await this.analyzeSubmission($, $form, analysis);
      
      // 8. ACCESSIBILITY & READABILITY ANALYSIS
      await this.analyzeAccessibility($, $form, analysis);

      // Calculate overall score
      let totalScore = 0;
      let totalMaxScore = 0;
      
      Object.values(analysis.categories).forEach(category => {
        totalScore += category.score;
        totalMaxScore += category.maxScore;
      });
      
      analysis.score = Math.round((totalScore / totalMaxScore) * 100);
      
      // Set AI accessibility flags
      this.setAIAccessibilityFlags(analysis);
      
      // Generate comprehensive recommendations
      this.generateComprehensiveRecommendations(analysis);
      
      console.log(`✅ Comprehensive analysis complete: ${analysis.score}/100`);
      return analysis;
      
    } catch (error) {
      console.error('Form analysis error:', error);
      return {
        score: 0,
        maxScore: 100,
        issues: [`Analysis failed: ${error.message}`],
        recommendations: ['Unable to analyze form structure'],
        aiAccessibility: {
          hasLabels: false,
          hasAriaLabels: false,
          hasNameAttributes: false,
          hasValidation: false,
          hasCaptcha: false,
          hasFileUpload: false
        },
        fieldAnalysis: []
      };
    }
  }

  /**
   * 1. Analyze Structural & Navigational Factors
   */
  async analyzeStructuralFactors($, $form, analysis) {
    const structural = analysis.categories.structural;
    
    // Check for <form> tag
    if ($form.length > 0) {
      structural.score += 3;
    } else {
      structural.issues.push('Missing <form> tag - AI agents need proper form structure');
      analysis.issues.push('Form lacks proper <form> tag structure');
    }
    
    // Check action URL and method
    const action = $form.attr('action');
    const method = $form.attr('method');
    
    if (action) {
      structural.score += 3;
      analysis.aiAccessibility.hasProperStructure = true;
    } else {
      structural.issues.push('Missing action attribute - AI agents need submission endpoint');
      analysis.issues.push('Form missing action URL for submission');
    }
    
    if (method && ['GET', 'POST'].includes(method.toUpperCase())) {
      structural.score += 3;
    } else {
      structural.issues.push('Missing or invalid method attribute - should be GET or POST');
      analysis.issues.push('Form method not specified or invalid');
    }
    
    // Check for role="form" on non-form containers
    const formRoles = $('[role="form"]');
    if (formRoles.length > 0 || $form.length > 0) {
      structural.score += 3;
    }
    
    // Check for predictable navigation (standard buttons/links)
    const submitButtons = $form.find('button[type="submit"], input[type="submit"]');
    if (submitButtons.length > 0) {
      structural.score += 3;
    } else {
      structural.issues.push('No standard submit button found - AI agents need clear submission method');
      analysis.issues.push('Form lacks standard submit button');
    }
  }

  /**
   * 2. Analyze Identification & Targeting Factors
   */
  async analyzeIdentificationFactors($, $form, analysis) {
    const identification = analysis.categories.identification;
    const fields = $form.find('input, textarea, select').not('[type="hidden"], [type="submit"]');
    
    let fieldsWithNames = 0;
    let fieldsWithIds = 0;
    let fieldsWithUniqueNames = 0;
    let dynamicIds = 0;
    
    const namesSeen = new Set();
    const idsSeen = new Set();
    
    fields.each((i, el) => {
      const $field = $(el);
      const name = $field.attr('name');
      const id = $field.attr('id');
      
      // Check name attributes
      if (name) {
        fieldsWithNames++;
        if (namesSeen.has(name)) {
          identification.issues.push(`Duplicate name attribute: ${name}`);
        } else {
          fieldsWithUniqueNames++;
          namesSeen.add(name);
        }
      }
      
      // Check ID attributes
      if (id) {
        fieldsWithIds++;
        if (idsSeen.has(id)) {
          identification.issues.push(`Duplicate ID attribute: ${id}`);
        } else {
          idsSeen.add(id);
        }
        
        // Check for dynamic/random IDs
        if (/\d{8,}|random|temp|gen/.test(id)) {
          dynamicIds++;
          identification.issues.push(`Potentially dynamic ID detected: ${id}`);
        }
      }
    });
    
    // Score based on name attributes (critical for AI)
    if (fields.length > 0) {
      identification.score += Math.round((fieldsWithNames / fields.length) * 8);
      identification.score += Math.round((fieldsWithUniqueNames / fields.length) * 4);
      identification.score += Math.round((fieldsWithIds / fields.length) * 4);
      
      if (dynamicIds === 0) {
        identification.score += 4;
      }
    }
    
    if (fieldsWithNames === fields.length) {
      analysis.aiAccessibility.hasNameAttributes = true;
    } else {
      identification.issues.push(`${fields.length - fieldsWithNames} fields missing name attributes`);
      analysis.issues.push('Some fields lack name attributes required for AI form submission');
    }
  }

  /**
   * 3. Analyze Labeling & Semantics Factors
   */
  async analyzeLabelingFactors($, $form, analysis) {
    const labeling = analysis.categories.labeling;
    const fields = $form.find('input, textarea, select').not('[type="hidden"], [type="submit"]');
    
    let fieldsWithLabels = 0;
    let fieldsWithAriaLabels = 0;
    let fieldsWithAriaLabelledBy = 0;
    
    fields.each((i, el) => {
      const $field = $(el);
      const id = $field.attr('id');
      const ariaLabel = $field.attr('aria-label');
      const ariaLabelledBy = $field.attr('aria-labelledby');
      
      let hasLabel = false;
      
      // Check for explicit label
      if (id && $(`label[for="${id}"]`).length > 0) {
        fieldsWithLabels++;
        hasLabel = true;
      }
      
      // Check for wrapping label
      if (!hasLabel && $field.closest('label').length > 0) {
        fieldsWithLabels++;
        hasLabel = true;
      }
      
      // Check for ARIA labels
      if (ariaLabel) {
        fieldsWithAriaLabels++;
        hasLabel = true;
      }
      
      if (ariaLabelledBy) {
        fieldsWithAriaLabelledBy++;
        hasLabel = true;
      }
      
      if (!hasLabel) {
        labeling.issues.push(`Field ${$field.attr('name') || 'unnamed'} lacks proper labeling`);
      }
    });
    
    if (fields.length > 0) {
      labeling.score += Math.round((fieldsWithLabels / fields.length) * 8);
      labeling.score += Math.round((fieldsWithAriaLabels / fields.length) * 4);
      labeling.score += Math.round((fieldsWithAriaLabelledBy / fields.length) * 3);
    }
    
    analysis.aiAccessibility.hasLabels = fieldsWithLabels > 0;
    analysis.aiAccessibility.hasAriaLabels = fieldsWithAriaLabels > 0;
    
    if (fieldsWithLabels < fields.length) {
      analysis.issues.push('Some fields lack proper labels for AI identification');
    }
  }

  /**
   * 4. Analyze Input Hints & Autocomplete
   */
  async analyzeInputHints($, $form, analysis) {
    const hints = analysis.categories.inputHints;
    const fields = $form.find('input, textarea, select').not('[type="hidden"], [type="submit"]');
    
    let fieldsWithPlaceholders = 0;
    let fieldsWithAutocomplete = 0;
    let fieldsWithInputMode = 0;
    
    fields.each((i, el) => {
      const $field = $(el);
      
      if ($field.attr('placeholder')) {
        fieldsWithPlaceholders++;
      }
      
      if ($field.attr('autocomplete')) {
        fieldsWithAutocomplete++;
      }
      
      if ($field.attr('inputmode')) {
        fieldsWithInputMode++;
      }
    });
    
    if (fields.length > 0) {
      hints.score += Math.round((fieldsWithPlaceholders / fields.length) * 4);
      hints.score += Math.round((fieldsWithAutocomplete / fields.length) * 4);
      hints.score += Math.round((fieldsWithInputMode / fields.length) * 2);
    }
    
    analysis.aiAccessibility.hasAutocomplete = fieldsWithAutocomplete > 0;
    
    if (fieldsWithAutocomplete === 0) {
      hints.issues.push('No autocomplete attributes found - helpful for AI data entry');
    }
  }

  /**
   * 5. Analyze Data Types & Constraints
   */
  async analyzeDataTypes($, $form, analysis) {
    const dataTypes = analysis.categories.dataTypes;
    const fields = $form.find('input, textarea, select').not('[type="hidden"], [type="submit"]');
    
    let fieldsWithProperTypes = 0;
    let fieldsWithRequired = 0;
    let fieldsWithPatterns = 0;
    let fieldsWithConstraints = 0;
    
    fields.each((i, el) => {
      const $field = $(el);
      const type = $field.attr('type') || 'text';
      
      // Check for semantic input types
      const semanticTypes = ['email', 'tel', 'number', 'date', 'url', 'password', 'search'];
      if (semanticTypes.includes(type)) {
        fieldsWithProperTypes++;
      }
      
      if ($field.prop('required')) {
        fieldsWithRequired++;
      }
      
      if ($field.attr('pattern')) {
        fieldsWithPatterns++;
      }
      
      if ($field.attr('min') || $field.attr('max') || $field.attr('step') || 
          $field.attr('maxlength') || $field.attr('minlength')) {
        fieldsWithConstraints++;
      }
    });
    
    if (fields.length > 0) {
      dataTypes.score += Math.round((fieldsWithProperTypes / fields.length) * 6);
      dataTypes.score += Math.round((fieldsWithRequired / fields.length) * 3);
      dataTypes.score += Math.round((fieldsWithPatterns / fields.length) * 3);
      dataTypes.score += Math.round((fieldsWithConstraints / fields.length) * 3);
    }
    
    analysis.aiAccessibility.hasDataTypes = fieldsWithProperTypes > 0;
    
    if (fieldsWithProperTypes === 0) {
      dataTypes.issues.push('No semantic input types found - use email, tel, number, etc.');
    }
  }

  /**
   * 6. Analyze Validation & Feedback
   */
  async analyzeValidation($, $form, analysis) {
    const validation = analysis.categories.validation;
    
    // Check for validation attributes
    const hasRequired = $form.find('[required]').length > 0;
    const hasPattern = $form.find('[pattern]').length > 0;
    const hasAriaInvalid = $form.find('[aria-invalid]').length > 0;
    const hasAriaDescribedBy = $form.find('[aria-describedby]').length > 0;
    
    if (hasRequired || hasPattern) {
      validation.score += 3;
      analysis.aiAccessibility.hasValidation = true;
    }
    
    if (hasAriaInvalid) {
      validation.score += 2;
    }
    
    if (hasAriaDescribedBy) {
      validation.score += 2;
    }
    
    // Check for error message containers
    const errorContainers = $form.find('.error, .invalid, [role="alert"]');
    if (errorContainers.length > 0) {
      validation.score += 3;
    } else {
      validation.issues.push('No error message containers found');
    }
  }

  /**
   * 7. Analyze Submission Handling
   */
  async analyzeSubmission($, $form, analysis) {
    const submission = analysis.categories.submission;
    
    // Check for CAPTCHA (major AI blocker)
    const captchaElements = $form.find('[class*="captcha"], [id*="captcha"], [name*="captcha"]');
    const recaptchaElements = $form.find('[class*="recaptcha"], [id*="recaptcha"]');
    
    if (captchaElements.length > 0 || recaptchaElements.length > 0) {
      submission.issues.push('CAPTCHA detected - major blocker for AI agents');
      analysis.issues.push('CAPTCHA present - prevents AI form submission');
      analysis.aiAccessibility.hasCaptcha = true;
    } else {
      submission.score += 4;
    }
    
    // Check for CSRF tokens
    const csrfTokens = $form.find('input[name*="csrf"], input[name*="token"]');
    if (csrfTokens.length > 0) {
      submission.score += 3;
    } else {
      submission.issues.push('No CSRF token found - may cause submission failures');
    }
    
    // Check for file uploads
    const fileInputs = $form.find('input[type="file"]');
    if (fileInputs.length > 0) {
      analysis.aiAccessibility.hasFileUpload = true;
      submission.issues.push('File upload detected - complex for AI agents');
    } else {
      submission.score += 3;
    }
  }

  /**
   * 8. Analyze Accessibility & Readability
   */
  async analyzeAccessibility($, $form, analysis) {
    const accessibility = analysis.categories.accessibility;
    
    // Check for ARIA roles and states
    const ariaElements = $form.find('[aria-required], [aria-invalid], [role]');
    if (ariaElements.length > 0) {
      accessibility.score += 2;
    }
    
    // Check for live regions
    const liveRegions = $form.find('[aria-live]');
    if (liveRegions.length > 0) {
      accessibility.score += 2;
    }
    
    // Check for fieldsets and legends
    const fieldsets = $form.find('fieldset');
    if (fieldsets.length > 0) {
      accessibility.score += 1;
    }
  }

  /**
   * Set AI accessibility flags based on analysis
   */
  setAIAccessibilityFlags(analysis) {
    const structural = analysis.categories.structural;
    const identification = analysis.categories.identification;
    const labeling = analysis.categories.labeling;
    
    analysis.aiAccessibility.hasProperStructure = structural.score >= 10;
    analysis.aiAccessibility.hasNameAttributes = identification.score >= 12;
    analysis.aiAccessibility.hasLabels = labeling.score >= 8;
  }

  /**
   * Generate comprehensive recommendations
   */
  generateComprehensiveRecommendations(analysis) {
    // Collect all category-specific issues
    Object.entries(analysis.categories).forEach(([category, data]) => {
      if (data.issues.length > 0) {
        analysis.recommendations.push(`${category.toUpperCase()}: ${data.issues.join(', ')}`);
      }
    });
    
    // Add high-level recommendations
    if (analysis.score < 70) {
      analysis.recommendations.push('Form requires significant improvements for AI agent compatibility');
    }
    
    if (!analysis.aiAccessibility.hasNameAttributes) {
      analysis.recommendations.push('CRITICAL: Add name attributes to all form fields');
    }
    
    if (analysis.aiAccessibility.hasCaptcha) {
      analysis.recommendations.push('CRITICAL: Remove or provide alternatives to CAPTCHA for AI agents');
    }
    
    if (!analysis.aiAccessibility.hasLabels) {
      analysis.recommendations.push('HIGH: Add proper labels or ARIA labels to all fields');
    }
  }

  /**
   * Tool: prioritizePages
   * Intelligently prioritize pages based on likelihood of containing forms
   */
  async prioritizePages() {
    const crawlStats = await this.checkUndiscovered();
    const allPages = [...crawlStats.visited, ...crawlStats.undiscovered];
    
    console.log(`🎯 Prioritizing ${allPages.length} discovered pages for form analysis...`);
    
    const prioritizedPages = allPages.map(url => {
      const urlLower = url.toLowerCase();
      let priority = 'low';
      let reason = 'general page';
      let score = 1;

      // High priority - very likely to have forms (score 8-10)
      if (urlLower.includes('contact')) {
        priority = 'high'; reason = 'contact page'; score = 10;
      } else if (urlLower.includes('feedback') || urlLower.includes('support')) {
        priority = 'high'; reason = 'feedback/support page'; score = 9;
      } else if (urlLower.includes('quote') || urlLower.includes('estimate')) {
        priority = 'high'; reason = 'quote/estimate page'; score = 9;
      } else if (urlLower.includes('signup') || urlLower.includes('register')) {
        priority = 'high'; reason = 'registration page'; score = 8;
      } else if (urlLower.includes('login') || urlLower.includes('account')) {
        priority = 'high'; reason = 'login/account page'; score = 8;
      }
      // Medium priority - might have forms (score 4-7)
      else if (urlLower.includes('about') || urlLower.includes('service')) {
        priority = 'medium'; reason = 'about/services page'; score = 6;
      } else if (urlLower.includes('booking') || urlLower.includes('appointment')) {
        priority = 'medium'; reason = 'booking page'; score = 7;
      } else if (urlLower.includes('newsletter') || urlLower.includes('subscribe')) {
        priority = 'medium'; reason = 'subscription page'; score = 6;
      } else if (urlLower.includes('financing') || urlLower.includes('payment')) {
        priority = 'medium'; reason = 'financing page'; score = 5;
      }
      // Homepage gets medium priority
      else if (url.endsWith('/') && !url.includes('/', url.indexOf('://') + 3)) {
        priority = 'medium'; reason = 'homepage'; score = 5;
      }
      // Low priority but still check (score 1-3)
      else if (urlLower.includes('blog') || urlLower.includes('news')) {
        priority = 'low'; reason = 'blog/news page'; score = 2;
      }

      return { url, priority, reason, score };
    });

    // Sort by score (highest first), then by priority
    const sorted = prioritizedPages.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });

    console.log(`📋 Top 10 prioritized pages:`);
    sorted.slice(0, 10).forEach((page, i) => {
      console.log(`   ${i + 1}. [${page.priority.toUpperCase()}] ${page.url}`);
      console.log(`      Reason: ${page.reason} (score: ${page.score})`);
    });

    return {
      prioritizedPages: sorted,
      highPriority: sorted.filter(p => p.priority === 'high'),
      mediumPriority: sorted.filter(p => p.priority === 'medium'),
      lowPriority: sorted.filter(p => p.priority === 'low'),
      totalPages: sorted.length
    };
  }

  /**
   * Tool: checkUndiscovered
   * Returns URLs that have been discovered but not yet visited
   */
  async checkUndiscovered() {
    const undiscovered = Array.from(this.discovered).filter(url => !this.visited.has(url));
    
    console.log(`📈 Coverage: ${this.visited.size} visited, ${undiscovered.length} remaining`);
    
    return {
      undiscovered,
      visited: Array.from(this.visited),
      totalDiscovered: this.discovered.size,
      coveragePercentage: this.discovered.size > 0 ? Math.round((this.visited.size / this.discovered.size) * 100) : 0
    };
  }

  /**
   * Get comprehensive scan results
   */
  getScanResults() {
    return {
      summary: {
        totalPages: this.visited.size,
        totalForms: this.forms.length,
        discoveredUrls: this.discovered.size,
        visitedUrls: this.visited.size,
        coveragePercentage: this.discovered.size > 0 ? Math.round((this.visited.size / this.discovered.size) * 100) : 0
      },
      pages: Array.from(this.visited),
      forms: this.forms,
      networkLogs: this.networkLogs
    };
  }
}

/**
 * Tool definitions for OpenAI function calling
 */
export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "fetchSitemap",
      description: "Fetches /sitemap.xml from the target website and returns an array of URLs to crawl",
      parameters: {
        type: "object",
        properties: {
          baseUrl: {
            type: "string",
            description: "The base URL of the website to fetch sitemap from"
          }
        },
        required: ["baseUrl"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "goToPage",
      description: "Navigates to a specific URL using Playwright and returns the HTML content and discovered links",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to navigate to"
          }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "extractForms",
      description: "Parses HTML content and extracts all forms with their fields and characteristics",
      parameters: {
        type: "object",
        properties: {
          html: {
            type: "string",
            description: "The HTML content to parse for forms"
          }
        },
        required: ["html"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fillForm",
      description: "Attempts to fill a form with realistic dummy data and validate it",
      parameters: {
        type: "object",
        properties: {
          formHtml: {
            type: "string",
            description: "The HTML of the form to fill"
          },
          formUrl: {
            type: "string",
            description: "The URL where the form is located"
          }
        },
        required: ["formHtml", "formUrl"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyzeFormAccessibility",
      description: "Analyzes a form's HTML for AI-friendliness and accessibility, providing scores and recommendations",
      parameters: {
        type: "object",
        properties: {
          formHtml: {
            type: "string",
            description: "The HTML of the form to analyze"
          }
        },
        required: ["formHtml"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "prioritizePages",
      description: "Intelligently prioritizes discovered pages based on likelihood of containing forms (contact, signup, etc. get highest priority)",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "checkUndiscovered",
      description: "Returns URLs that have been discovered but not yet visited, helping track crawling progress",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }
];
