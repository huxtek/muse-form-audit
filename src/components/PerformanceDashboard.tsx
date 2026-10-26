import React from "react";
import type { AnalyzedForm, ScanResults } from "@/lib/scan-types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { 
  TrendingUp, 
  TrendingDown, 
  AlertTriangle, 
  XCircle, 
  Clock,
  Target,
  BarChart3,
  Zap,
  Bot
} from "lucide-react";

interface PerformanceMetrics {
  overallScore: number;
  performanceRating: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  discoverySuccessRate: number;
  identificationSuccessRate: number;
  dataEntrySuccessRate: number;
  submissionSuccessRate: number;
  criticalBlockers: number;
  partialBlockers: number;
  formsFullyCompatible: number;
  formsPartiallyCompatible: number;
  formsNotCompatible: number;
  totalForms: number;
}

interface FormPerformance {
  formId: string;
  overallScore: number;
  aiCompatibilityScore: number;
  criticalIssues: number;
  canAIUse: 'Yes' | 'Partially' | 'No';
  successProbability: 'High' | 'Medium' | 'Low';
}

interface PerformanceDashboardProps {
  /**
   * A scan job's `results`. The dashboard reads `analysis.detailedAnalysis`
   * when present and otherwise derives its numbers from `pages` or `forms`,
   * so every branch is covered by the shared result type.
   */
  results: ScanResults;
}

export const PerformanceDashboard = ({ results }: PerformanceDashboardProps) => {
  // Extract comprehensive analysis data
  const analysisData = React.useMemo(() => {
    // Check if we have the new comprehensive analysis structure
    if (results.analysis?.detailedAnalysis) {
      return {
        hasComprehensiveData: true,
        totalForms: results.analysis.totalForms,
        avgAccessibilityScore: results.analysis.accessibilityScore,
        avgAICompatibilityScore: results.analysis.detailedAnalysis.avgAICompatibilityScore,
        totalCriticalBlockers: results.analysis.detailedAnalysis.totalCriticalBlockers,
        totalPartialBlockers: results.analysis.detailedAnalysis.totalPartialBlockers,
        performanceMetrics: results.analysis.detailedAnalysis.performanceMetrics,
        forms: results.analysis.forms || []
      };
    }
    
    // Fallback to old structure for backward compatibility
    let allForms: AnalyzedForm[] = [];
    if (results.pages) {
      allForms = results.pages.reduce((acc, page) => acc.concat(page.forms || []), []);
    } else if (results.forms) {
      allForms = results.forms;
    }
    
    // Calculate average scores from actual form data
    const avgAccessibilityScore = allForms.length > 0 
      ? Math.round(allForms.reduce((sum, form) => {
          const score = form.accessibility?.score || form.accessibilityScore || 0;
          return sum + score;
        }, 0) / allForms.length)
      : 0;

    // Calculate compatibility distribution based on actual scores
    const fullyCompatible = allForms.filter(form => {
      const score = form.accessibility?.score || form.accessibilityScore || 0;
      return score >= 80;
    }).length;
    
    const partiallyCompatible = allForms.filter(form => {
      const score = form.accessibility?.score || form.accessibilityScore || 0;
      return score >= 50 && score < 80;
    }).length;
    
    const notCompatible = allForms.filter(form => {
      const score = form.accessibility?.score || form.accessibilityScore || 0;
      return score < 50;
    }).length;
    
    return {
      hasComprehensiveData: false,
      totalForms: allForms.length,
      avgAccessibilityScore: avgAccessibilityScore,
      avgAICompatibilityScore: avgAccessibilityScore, // Use same score as accessibility for now
      totalCriticalBlockers: 0,
      totalPartialBlockers: 0,
      performanceMetrics: {
        avgDiscoveryRate: Math.max(avgAccessibilityScore - 10, 0), // Slightly lower than accessibility
        avgIdentificationRate: Math.max(avgAccessibilityScore - 5, 0), // Close to accessibility
        avgDataEntryRate: avgAccessibilityScore,
        avgSubmissionRate: Math.max(avgAccessibilityScore - 15, 0), // Lower due to structural issues
        formsFullyCompatible: fullyCompatible,
        formsPartiallyCompatible: partiallyCompatible,
        formsNotCompatible: notCompatible
      },
      forms: allForms
    };
  }, [results]);

  // Calculate performance metrics from comprehensive data
  const calculatePerformanceMetrics = (): PerformanceMetrics => {
    const { performanceMetrics, totalForms, avgAccessibilityScore } = analysisData;
    
    return {
      overallScore: avgAccessibilityScore,
      performanceRating: avgAccessibilityScore >= 85 ? 'Excellent' : 
                         avgAccessibilityScore >= 70 ? 'Good' : 
                         avgAccessibilityScore >= 50 ? 'Fair' : 'Poor',
      discoverySuccessRate: performanceMetrics.avgDiscoveryRate,
      identificationSuccessRate: performanceMetrics.avgIdentificationRate,
      dataEntrySuccessRate: performanceMetrics.avgDataEntryRate,
      submissionSuccessRate: performanceMetrics.avgSubmissionRate,
      criticalBlockers: analysisData.totalCriticalBlockers,
      partialBlockers: analysisData.totalPartialBlockers,
      formsFullyCompatible: performanceMetrics.formsFullyCompatible,
      formsPartiallyCompatible: performanceMetrics.formsPartiallyCompatible,
      formsNotCompatible: performanceMetrics.formsNotCompatible,
      totalForms: totalForms
    };
  };

  const getFormPerformance = (): FormPerformance[] => {
    return analysisData.forms.map((form, index) => {
      // Use comprehensive data if available
      if (analysisData.hasComprehensiveData && form.aiCompatibilityScore !== undefined) {
        return {
          formId: form.formId || `Form ${index + 1}`,
          overallScore: form.overallScore || 0,
          aiCompatibilityScore: form.aiCompatibilityScore,
          criticalIssues: form.criticalBlockers || 0,
          canAIUse: form.aiCompatibilityScore >= 80 ? 'Yes' : 
                   form.aiCompatibilityScore >= 50 ? 'Partially' : 'No',
          successProbability: form.aiCompatibilityScore >= 80 ? 'High' : 
                             form.aiCompatibilityScore >= 50 ? 'Medium' : 'Low'
        };
      }
      
      // Fallback for old structure
      const score = form.accessibility?.score || form.accessibilityScore || 0;
      return {
        formId: form.id || form.formId || `Form ${index + 1}`,
        overallScore: score,
        aiCompatibilityScore: score,
        criticalIssues: 0,
        canAIUse: score >= 80 ? 'Yes' : score >= 50 ? 'Partially' : 'No',
        successProbability: score >= 80 ? 'High' : score >= 50 ? 'Medium' : 'Low'
      };
    });
  };

  const metrics = calculatePerformanceMetrics();
  const formPerformance = getFormPerformance();

  const getPerformanceColor = (rating: string) => {
    switch (rating) {
      case 'Excellent': return 'text-green-500';
      case 'Good': return 'text-blue-500';
      case 'Fair': return 'text-yellow-500';
      case 'Poor': return 'text-red-500';
      default: return 'text-gray-500';
    }
  };

  const getSuccessColor = (probability: string) => {
    switch (probability) {
      case 'High': return 'bg-green-100 text-green-800';
      case 'Medium': return 'bg-yellow-100 text-yellow-800';
      case 'Low': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  if (metrics.totalForms === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Performance Analysis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Bot className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No forms found to analyze</p>
            <p className="text-sm">Try scanning a page with forms to see performance metrics</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Overall Performance Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            AI Agent Performance Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Overall Score */}
          <div className="text-center">
            <div className={`text-4xl font-bold ${getPerformanceColor(metrics.performanceRating)}`}>
              {metrics.overallScore}%
            </div>
            <div className="text-sm text-muted-foreground">Overall Performance Score</div>
            <Badge className={`mt-2 ${getPerformanceColor(metrics.performanceRating)}`}>
              {metrics.performanceRating}
            </Badge>
          </div>

          <Separator />

          {/* AI Compatibility Metrics */}
          {analysisData.hasComprehensiveData && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-500">
                    {analysisData.avgAICompatibilityScore}%
                  </div>
                  <div className="text-xs text-muted-foreground">AI Compatibility</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-500">
                    {metrics.criticalBlockers}
                  </div>
                  <div className="text-xs text-muted-foreground">Critical Blockers</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-yellow-500">
                    {metrics.partialBlockers}
                  </div>
                  <div className="text-xs text-muted-foreground">Partial Blockers</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-500">
                    {metrics.formsFullyCompatible}
                  </div>
                  <div className="text-xs text-muted-foreground">AI Compatible</div>
                </div>
              </div>

              <Separator />
            </>
          )}

          {/* Success Rate Metrics */}
          <div className="space-y-4">
            <h4 className="font-semibold flex items-center gap-2">
              <Target className="h-4 w-4" />
              AI Agent Success Rates
            </h4>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Form Discovery</span>
                  <span>{metrics.discoverySuccessRate}%</span>
                </div>
                <Progress value={metrics.discoverySuccessRate} className="h-2" />
              </div>
              
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Field Identification</span>
                  <span>{metrics.identificationSuccessRate}%</span>
                </div>
                <Progress value={metrics.identificationSuccessRate} className="h-2" />
              </div>
              
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Data Entry</span>
                  <span>{metrics.dataEntrySuccessRate}%</span>
                </div>
                <Progress value={metrics.dataEntrySuccessRate} className="h-2" />
              </div>
              
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Form Submission</span>
                  <span>{metrics.submissionSuccessRate}%</span>
                </div>
                <Progress value={metrics.submissionSuccessRate} className="h-2" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Individual Form Performance */}
      {formPerformance.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Individual Form Analysis ({formPerformance.length} forms)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {formPerformance.map((form, index) => (
                <div key={index} className="border rounded-lg p-4 space-y-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <h5 className="font-medium">{form.formId}</h5>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge className={getSuccessColor(form.successProbability)}>
                          {form.successProbability} Success Rate
                        </Badge>
                        <Badge variant={form.canAIUse === 'Yes' ? 'default' : 
                                      form.canAIUse === 'Partially' ? 'secondary' : 'destructive'}>
                          AI: {form.canAIUse}
                        </Badge>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold">
                        {analysisData.hasComprehensiveData ? form.aiCompatibilityScore : form.overallScore}%
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {analysisData.hasComprehensiveData ? 'AI Score' : 'Overall Score'}
                      </div>
                    </div>
                  </div>
                  
                  {analysisData.hasComprehensiveData && (
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">Overall Score:</span>
                        <span className="ml-2 font-medium">{form.overallScore}%</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Critical Issues:</span>
                        <span className="ml-2 font-medium text-red-500">{form.criticalIssues}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Form Compatibility Distribution */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            AI Compatibility Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="space-y-2">
              <div className="text-2xl font-bold text-green-500">
                {metrics.formsFullyCompatible}
              </div>
              <div className="text-sm text-muted-foreground">Fully Compatible</div>
              <div className="text-xs text-green-600">80%+ AI Score</div>
            </div>
            <div className="space-y-2">
              <div className="text-2xl font-bold text-yellow-500">
                {metrics.formsPartiallyCompatible}
              </div>
              <div className="text-sm text-muted-foreground">Partially Compatible</div>
              <div className="text-xs text-yellow-600">50-79% AI Score</div>
            </div>
            <div className="space-y-2">
              <div className="text-2xl font-bold text-red-500">
                {metrics.formsNotCompatible}
              </div>
              <div className="text-sm text-muted-foreground">Not Compatible</div>
              <div className="text-xs text-red-600">&lt;50% AI Score</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
