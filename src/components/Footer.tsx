import React from 'react';
import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';

const Footer = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-card/30 backdrop-blur-sm border-t border-border/50 pt-12 pb-8 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-8">
          <div className="max-w-sm">
            <Link to="/" className="flex items-center space-x-2 mb-4 hover:opacity-80 transition-opacity">
              <Bot className="w-8 h-8 text-primary" />
              <span className="font-bold text-xl">HuxTek</span>
            </Link>
            <p className="text-muted-foreground">
              Making web forms compatible with AI agents through comprehensive analysis and
              actionable recommendations.
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-foreground mb-4">Open Source</h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              Released under the MIT license. Run it locally, point it at your own sites, and
              extend the agent however you like.
            </p>
          </div>
        </div>

        <div className="border-t border-border/50 mt-10 pt-6">
          <p className="text-sm text-muted-foreground">
            &copy; {currentYear} HuxTek. Released under the MIT license.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
