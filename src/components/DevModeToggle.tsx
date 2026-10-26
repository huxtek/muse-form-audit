import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Code, Zap } from 'lucide-react';
import { useDevMode } from '@/contexts/DevModeContext';

const DevModeToggle: React.FC = () => {
  const { isDevMode, toggleDevMode, isDevEnvironment } = useDevMode();

  // Don't render in production
  if (!isDevEnvironment) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant={isDevMode ? "default" : "outline"}
        size="sm"
        onClick={toggleDevMode}
        className="flex items-center gap-2"
      >
        {isDevMode ? (
          <>
            <Zap className="h-4 w-4" />
            Dev Mode
          </>
        ) : (
          <>
            <Code className="h-4 w-4" />
            Production
          </>
        )}
      </Button>
      
      {isDevMode && (
        <Badge variant="secondary" className="text-xs">
          Mock Data
        </Badge>
      )}
    </div>
  );
};

export default DevModeToggle;
