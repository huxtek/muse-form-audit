import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface DevModeContextType {
  isDevMode: boolean;
  toggleDevMode: () => void;
  isDevEnvironment: boolean;
}

const DevModeContext = createContext<DevModeContextType | undefined>(undefined);

export const useDevMode = () => {
  const context = useContext(DevModeContext);
  if (context === undefined) {
    throw new Error('useDevMode must be used within a DevModeProvider');
  }
  return context;
};

interface DevModeProviderProps {
  children: ReactNode;
}

export const DevModeProvider: React.FC<DevModeProviderProps> = ({ children }) => {
  // Check if we're in development environment
  const isDevEnvironment = import.meta.env.DEV || import.meta.env.NODE_ENV === 'development';
  
  // Initialize dev mode state (default to ON in development)
  const [isDevMode, setIsDevMode] = useState(() => {
    if (!isDevEnvironment) return false; // Always false in production
    
    // In development, check localStorage or default to true
    const saved = localStorage.getItem('muse-form-audit-dev-mode');
    return saved !== null ? JSON.parse(saved) : true;
  });

  // Save dev mode state to localStorage
  useEffect(() => {
    if (isDevEnvironment) {
      localStorage.setItem('muse-form-audit-dev-mode', JSON.stringify(isDevMode));
    }
  }, [isDevMode, isDevEnvironment]);

  const toggleDevMode = () => {
    if (isDevEnvironment) {
      setIsDevMode(prev => !prev);
    }
  };

  const value = {
    isDevMode: isDevEnvironment ? isDevMode : false, // Force false in production
    toggleDevMode,
    isDevEnvironment
  };

  return (
    <DevModeContext.Provider value={value}>
      {children}
    </DevModeContext.Provider>
  );
};
