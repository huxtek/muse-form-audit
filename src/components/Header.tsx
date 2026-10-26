import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import DevModeToggle from '@/components/DevModeToggle';

const Header = () => {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 h-16 px-6 transition-all duration-300 ${
        isScrolled
          ? 'bg-background/95 backdrop-blur-md border-b border-border/50 shadow-sm'
          : 'bg-background/80 backdrop-blur-sm'
      }`}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between h-full">
        <Link to="/" className="flex items-center space-x-2">
          <Bot className="w-8 h-8 text-primary" />
          <span className="font-bold text-xl hidden sm:inline-block">Muse Form Audit</span>
        </Link>

        <div className="flex items-center space-x-4">
          <DevModeToggle />
        </div>
      </div>
    </header>
  );
};

export default Header;
