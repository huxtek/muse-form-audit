import React from 'react';
import type { AnalyzedForm, FormCharacteristics, ScanSummary } from '@/lib/scan-types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  FileText, 
  Eye, 
  Shield, 
  Zap,
  Target,
  Settings,
  AlertCircle,
  Info
} from 'lucide-react';

interface FormAnalysisDisplayProps {
  forms: AnalyzedForm[];
  summary?: ScanSummary;
  aiSummary?: string;
  scanMode?: string;
}

const FormAnalysisDisplay: React.FC<FormAnalysisDisplayProps> = ({ 
  forms = [], 
  summary = {}, 
  aiSummary,
  scanMode 
}) => {
  const getScoreColor = (score: number = 0, maxScore: number = 100) => {
    const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;
    if (percentage >= 80) return 'text-green-600';
    if (percentage >= 60) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getScoreBadgeVariant = (score: number = 0, maxScore: number = 100) => {
    const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;
    if (percentage >= 80) return 'default';
    if (percentage >= 60) return 'secondary';
    return 'destructive';
  };

  const getFieldTypeIcon = (type: string = '') => {
    switch (type.toLowerCase()) {
      case 'email': return '📧';
      case 'password': return '🔒';
      case 'tel': case 'phone': return '📞';
      case 'number': return '🔢';
      case 'date': return '📅';
      case 'checkbox': return '☑️';
      case 'radio': return '🔘';
      case 'select': return '📋';
      case 'textarea': return '📝';
      case 'submit': return '🚀';
      case 'button': return '🔘';
      case 'file': return '📎';
      default: return '📝';
    }
  };

  const getFormTypeIcon = (characteristics: FormCharacteristics = {}) => {
    if (characteristics.isLoginForm) return '🔐';
    if (characteristics.isContactForm) return '📞';
    if (characteristics.isSearchForm) return '🔍';
    return '📋';
  };

  return (
    <div className="space-y-6">
      {/* Summary Section */}
      {Object.keys(summary).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              Scan Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-primary">{summary.totalPages || 0}</div>
                <div className="text-sm text-muted-foreground">Pages Analyzed</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-primary">{summary.totalForms || 0}</div>
                <div className="text-sm text-muted-foreground">Forms Found</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-primary">{summary.visitedUrls || 0}</div>
                <div className="text-sm text-muted-foreground">URLs Visited</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-primary">{summary.coveragePercentage || 0}%</div>
                <div className="text-sm text-muted-foreground">Coverage</div>
              </div>
            </div>
            
            {scanMode && (
              <div className="mt-4 pt-4 border-t">
                <Badge variant="outline" className="capitalize">
                  {scanMode.replace('-', ' ')} Analysis
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* AI Summary */}
      {aiSummary && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              AI Analysis Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{aiSummary}</p>
          </CardContent>
        </Card>
      )}

      {/* Forms Analysis */}
      {forms.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Form Analysis ({forms.length} form{forms.length !== 1 ? 's' : ''})
          </h3>
          
          {forms.map((form, index) => (
            <Card key={`${form.url || 'page'}-${form.formId || 'form'}-${index}`} className="overflow-hidden">
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{getFormTypeIcon(form.characteristics)}</span>
                    <span>Form {index + 1}</span>
                    {form.formId && (
                      <Badge variant="outline" className="text-xs">
                        ID: {form.formId}
                      </Badge>
                    )}
                  </div>
                  
                  {form.accessibility?.score !== undefined && (
                    <Badge variant={getScoreBadgeVariant(form.accessibility.score, form.accessibility.maxScore)}>
                      {form.accessibility.score}/{form.accessibility.maxScore || 100}
                    </Badge>
                  )}
                </CardTitle>
                
                {form.url && (
                  <p className="text-sm text-muted-foreground truncate">{form.url}</p>
                )}
              </CardHeader>
              
              <CardContent className="space-y-6">
                {/* Form Characteristics */}
                {form.characteristics && (
                  <div>
                    <h4 className="font-medium mb-3 flex items-center gap-2">
                      <Settings className="h-4 w-4" />
                      Form Characteristics
                    </h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {Object.entries(form.characteristics).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-2">
                          {value ? (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          ) : (
                            <XCircle className="h-4 w-4 text-gray-400" />
                          )}
                          <span className="text-sm capitalize">
                            {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Accessibility Score */}
                {form.accessibility && (
                  <div>
                    <h4 className="font-medium mb-3 flex items-center gap-2">
                      <Shield className="h-4 w-4" />
                      AI Accessibility Score
                    </h4>
                    
                    <div className="space-y-4">
                      {/* Overall Score */}
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-sm font-medium">Overall Score</span>
                          <div className="flex items-center gap-2">
                            {form.accessibility.analysisSource && (
                              <Badge variant="outline" className="text-xs">
                                {form.accessibility.analysisSource === 'model'
                                  ? 'Scored by model'
                                  : 'Heuristic fallback'}
                              </Badge>
                            )}
                            <span className={`font-bold ${getScoreColor(form.accessibility.score, form.accessibility.maxScore)}`}>
                              {form.accessibility.score || 0}/{form.accessibility.maxScore || 100}
                            </span>
                          </div>
                        </div>
                        {form.accessibility.narrative && (
                          <p className="text-sm text-muted-foreground mb-2">
                            {form.accessibility.narrative}
                          </p>
                        )}
                        <Progress 
                          value={form.accessibility.maxScore ? (form.accessibility.score || 0) / form.accessibility.maxScore * 100 : 0} 
                          className="h-2"
                        />
                      </div>

                      {/* The per-category bars used to be repeated here,
                          under every form, directly below the same eight bars
                          in the breakdown panel at the top of this tab. On a
                          single-form scan that was the identical set of
                          numbers twice on one screen. The breakdown owns them
                          now; this keeps the form's own total and whatever
                          the model wrote about it. */}
                    </div>
                  </div>
                )}

                {/* AI Compatibility Features */}
                {form.accessibility?.aiAccessibility && (
                  <div>
                    <h4 className="font-medium mb-3 flex items-center gap-2">
                      <Eye className="h-4 w-4" />
                      AI Compatibility Features
                    </h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {Object.entries(form.accessibility.aiAccessibility).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-2">
                          {value ? (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-500" />
                          )}
                          <span className="text-sm">
                            {key.replace(/([A-Z])/g, ' $1').replace(/^has/, '').trim()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Form Fields */}
                {form.fields && form.fields.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-3 flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Form Fields ({form.fields.length})
                    </h4>
                    <div className="space-y-3">
                      {form.fields.map((field, fieldIndex) => (
                        <div key={field.id || fieldIndex} className="border rounded-lg p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-lg">{getFieldTypeIcon(field.type)}</span>
                              <span className="font-medium">
                                {field.label || field.name || field.id || `Field ${fieldIndex + 1}`}
                              </span>
                              {field.required && (
                                <Badge variant="destructive" className="text-xs">Required</Badge>
                              )}
                              {field.disabled && (
                                <Badge variant="secondary" className="text-xs">Disabled</Badge>
                              )}
                            </div>
                            <Badge variant="outline" className="text-xs">
                              {field.type || 'text'}
                            </Badge>
                          </div>
                          
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-muted-foreground">
                            {field.id && (
                              <div><span className="font-medium">ID:</span> {field.id}</div>
                            )}
                            {field.name && (
                              <div><span className="font-medium">Name:</span> {field.name}</div>
                            )}
                            {field.placeholder && (
                              <div><span className="font-medium">Placeholder:</span> {field.placeholder}</div>
                            )}
                            {field.ariaLabel && (
                              <div><span className="font-medium">ARIA Label:</span> {field.ariaLabel}</div>
                            )}
                            {field.value && (
                              <div><span className="font-medium">Value:</span> {field.value}</div>
                            )}
                          </div>
                          
                          {field.options && field.options.length > 0 && (
                            <div className="text-sm">
                              <span className="font-medium">Options:</span> {field.options.join(', ')}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Problems beside their fixes, under one heading.
                    These were two stacked lists, and because the first is as
                    tall as its contents the heading of the second sat some
                    260px below the problem it answered. They are not zipped
                    into pairs, because nothing in the data keys one to the
                    other and the counts often disagree -- one sample form
                    carries four problems against eight fixes. Side by side is
                    as far as the data honestly allows. */}
                {((form.accessibility?.issues?.length || 0) > 0 ||
                  (form.accessibility?.recommendations?.length || 0) > 0) && (
                  <div>
                    <h4 className="font-medium mb-3 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      Issues and fixes
                    </h4>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {form.accessibility.issues && form.accessibility.issues.length > 0 && (
                        <div>
                          <h5 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                            Problems ({form.accessibility.issues.length})
                          </h5>
                          <div className="space-y-2">
                            {form.accessibility.issues.map((issue, issueIndex) => (
                              <div key={issueIndex} className="flex items-start gap-2 p-3 bg-muted/40 border-l-2 border-destructive rounded-r-md">
                                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                                <span className="text-sm text-foreground">{issue}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {form.accessibility.recommendations && form.accessibility.recommendations.length > 0 && (
                        <div>
                          <h5 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                            Suggested fixes ({form.accessibility.recommendations.length})
                          </h5>
                          <div className="space-y-2">
                            {form.accessibility.recommendations.map((rec, recIndex) => (
                              <div key={recIndex} className="flex items-start gap-2 p-3 bg-muted/40 border-l-2 border-sky-500 rounded-r-md">
                                <Info className="h-4 w-4 text-sky-500 mt-0.5 flex-shrink-0" />
                                <span className="text-sm text-foreground">{rec}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default FormAnalysisDisplay;
