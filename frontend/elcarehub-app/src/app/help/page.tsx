// ─────────────────────────────────────────────────────────────
// app/help/page.tsx — Help and Troubleshooting Page
// ─────────────────────────────────────────────────────────────

"use client";

import { useState } from "react";
import { 
  HelpCircle, 
  Wallet, 
  Network, 
  AlertTriangle, 
  CheckCircle, 
  ExternalLink, 
  Search,
  Book,
  MessageCircle,
  Mail,
  Github,
  Twitter,
  ChevronDown,
  ChevronUp,
  Shield,
  Zap,
  Settings,
  RefreshCw
} from "lucide-react";

export default function HelpPage() {
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const toggleSection = (section: string) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  const faqSections = [
    {
      id: 'wallet-setup',
      title: 'Wallet Setup',
      icon: Wallet,
      color: 'text-brand-400',
      questions: [
        {
          q: 'How do I connect my wallet to ELCARE-HUB?',
          a: 'Click the "Connect Wallet" button in the top-right corner of the page. We support Freighter Wallet and other Stellar-compatible wallets. Make sure you have the wallet extension installed in your browser.'
        },
        {
          q: 'What wallets are supported?',
          a: 'We currently support Freighter Wallet, which is the most popular wallet for Stellar. Additional wallet support is coming soon.'
        },
        {
          q: 'How do I create a Stellar wallet?',
          a: 'You can create a Stellar wallet by installing Freighter Wallet from the Chrome Web Store or Firefox Add-ons. During setup, Freighter will automatically create a new wallet for you with a unique Stellar address.'
        },
        {
          q: 'How do I backup my wallet?',
          a: 'Your secret key (12-word recovery phrase) is extremely important. Write it down and store it in a secure location. Never share it with anyone or store it digitally. If you lose your secret key, you will lose access to your funds permanently.'
        }
      ]
    },
    {
      id: 'network-issues',
      title: 'Network Issues',
      icon: Network,
      color: 'text-brand-400',
      questions: [
        {
          q: 'What does "Wrong Network" mean?',
          a: 'This means your wallet is connected to a different Stellar network than what ELCARE-HUB expects. Click the "Wrong Network" alert to switch to the correct network automatically.'
        },
        {
          q: 'What is the difference between Public Network and Testnet?',
          a: 'The Public Network is the main Stellar network where real transactions occur with actual value. Testnet is a testing network with fake tokens used for development and testing purposes.'
        },
        {
          q: 'How do I switch networks?',
          a: 'You can switch networks by clicking the "Wrong Network" alert in the navbar, or by going to Settings → Network Status and selecting your preferred network.'
        },
        {
          q: 'Why can\'t I connect to the network?',
          a: 'This could be due to network connectivity issues, wallet problems, or Stellar network maintenance. Try refreshing the page, checking your internet connection, or restarting your browser.'
        }
      ]
    },
    {
      id: 'transaction-errors',
      title: 'Transaction Errors',
      icon: AlertTriangle,
      color: 'text-terracotta-400',
      questions: [
        {
          q: 'Why did my transaction fail?',
          a: 'Transactions can fail for several reasons: insufficient balance, network congestion, invalid signature, or contract errors. Check the error message for specific details.'
        },
        {
          q: 'What does "insufficient balance" mean?',
          a: 'You don\'t have enough XLM in your wallet to cover the transaction amount plus network fees. Each transaction on Stellar requires a small fee of 0.00001 XLM.'
        },
        {
          q: 'What are network fees?',
          a: 'Stellar charges a minimal fee of 0.00001 XLM per transaction to prevent spam. You also need to maintain a minimum balance of 1 XLM in your account.'
        },
        {
          q: 'How long do transactions take?',
          a: 'Most Stellar transactions confirm within 3-5 seconds. During high network congestion, it may take longer. You can check transaction status on Stellar explorers.'
        }
      ]
    },
    {
      id: 'account-issues',
      title: 'Account Issues',
      icon: Shield,
      color: 'text-mint-400',
      questions: [
        {
          q: 'Why can\'t I create listings?',
          a: 'Make sure your wallet is connected and you have sufficient XLM balance. Some features may require your account to be funded with at least 1 XLM minimum balance.'
        },
        {
          q: 'How do I fund my account?',
          a: 'You can purchase XLM from cryptocurrency exchanges like Coinbase, Binance, or Kraken, then transfer it to your Stellar wallet address.'
        },
        {
          q: 'What is the minimum balance requirement?',
          a: 'Stellar requires a minimum balance of 1 XLM per account. This reserve ensures network security and prevents spam.'
        },
        {
          q: 'How do I check my transaction history?',
          a: 'Enable "Transaction History" in Settings, or use Stellar explorers like Stellar.expert or Steexp.com to view your complete transaction history.'
        }
      ]
    },
    {
      id: 'security',
      title: 'Security',
      icon: Shield,
      color: 'text-mint-400',
      questions: [
        {
          q: 'How do I keep my wallet secure?',
          a: 'Never share your secret key or recovery phrase. Use hardware wallets for additional security. Be cautious of phishing attempts and only interact with official ELCARE-HUB URLs.'
        },
        {
          q: 'What is phishing and how do I avoid it?',
          a: 'Phishing is when attackers try to steal your credentials by impersonating legitimate websites. Always verify you\'re on the official ELCARE-HUB.io domain and never enter your secret key on untrusted sites.'
        },
        {
          q: 'Should I use a hardware wallet?',
          a: 'Hardware wallets provide the highest level of security by keeping your private keys offline. They are recommended for users holding significant amounts.'
        },
        {
          q: 'What should I do if I think my wallet is compromised?',
          a: 'Immediately transfer all funds to a new wallet with a new secret key. Change passwords on related services and enable two-factor authentication where possible.'
        }
      ]
    }
  ];

  const quickActions = [
    {
      title: 'Reset Connection',
      description: 'Disconnect and reconnect your wallet',
      icon: RefreshCw,
      action: () => window.location.href = '/'
    },
    {
      title: 'Check Network Status',
      description: 'Verify Stellar network status',
      icon: Network,
      action: () => window.open('https://stellar.expert/explorer/public', '_blank')
    },
    {
      title: 'Get Testnet XLM',
      description: 'Get free testnet tokens for testing',
      icon: Zap,
      action: () => window.open('https://laboratory.stellar.org/#account-creator?network=test', '_blank')
    },
    {
      title: 'View Documentation',
      description: 'Read our comprehensive documentation',
      icon: Book,
      action: () => window.open('https://docs.ELCARE-HUB.io', '_blank')
    }
  ];

  const contactMethods = [
    {
      title: 'Community Discord',
      description: 'Join our community for support',
      icon: MessageCircle,
      link: 'https://discord.gg/ELCARE-HUB',
      color: 'text-indigo-400'
    },
    {
      title: 'Email Support',
      description: 'support@ELCARE-HUB.io',
      icon: Mail,
      link: 'mailto:support@ELCARE-HUB.io',
      color: 'text-brand-400'
    },
    {
      title: 'GitHub Issues',
      description: 'Report bugs and feature requests',
      icon: Github,
      link: 'https://github.com/ELCARE-HUB/issues',
      color: 'text-gray-400'
    },
    {
      title: 'Twitter Support',
      description: '@ELCARE-HUB_support',
      icon: Twitter,
      link: 'https://twitter.com/ELCARE-HUB_support',
      color: 'text-blue-400'
    }
  ];

  const filteredSections = faqSections.map(section => ({
    ...section,
    questions: section.questions.filter(q => 
      q.q.toLowerCase().includes(searchQuery.toLowerCase()) ||
      q.a.toLowerCase().includes(searchQuery.toLowerCase())
    )
  })).filter(section => section.questions.length > 0);

  return (
    <div className="min-h-screen bg-midnight-950 pt-24">
      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <HelpCircle className="h-6 w-6 text-brand-400" />
            <h1 className="text-3xl font-bold text-white">Help & Support</h1>
          </div>
          <p className="text-gray-400">Find answers to common questions and get help with troubleshooting</p>
        </div>

        {/* Search Bar */}
        <div className="mb-8">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search for help topics..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-midnight-900 border border-white/5 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Quick Actions */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-white mb-4">Quick Actions</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {quickActions.map((action, index) => (
              <button
                key={index}
                onClick={action.action}
                className="flex items-center gap-3 p-4 bg-midnight-900 border border-white/5 rounded-xl hover:bg-white/5 transition-all text-left group"
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-brand-500/10 text-brand-400 group-hover:bg-brand-500/20">
                  <action.icon className="h-5 w-5" />
                </div>
                <div>
                  <div className="font-medium text-white">{action.title}</div>
                  <div className="text-sm text-gray-400">{action.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* FAQ Sections */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-white mb-4">Frequently Asked Questions</h2>
          <div className="space-y-4">
            {filteredSections.map((section) => (
              <div key={section.id} className="bg-midnight-900 border border-white/5 rounded-xl overflow-hidden">
                <button
                  onClick={() => toggleSection(section.id)}
                  className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-all"
                >
                  <div className="flex items-center gap-3">
                    <section.icon className={`h-5 w-5 ${section.color}`} />
                    <span className="font-medium text-white">{section.title}</span>
                  </div>
                  {expandedSection === section.id ? (
                    <ChevronUp className="h-5 w-5 text-gray-400" />
                  ) : (
                    <ChevronDown className="h-5 w-5 text-gray-400" />
                  )}
                </button>
                
                {expandedSection === section.id && (
                  <div className="border-t border-white/5">
                    {section.questions.map((qa, index) => (
                      <div key={index} className="p-4 border-b border-white/5 last:border-b-0">
                        <h3 className="font-medium text-white mb-2">{qa.q}</h3>
                        <p className="text-gray-400 text-sm leading-relaxed">{qa.a}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Common Issues */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-white mb-4">Common Issues & Solutions</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-midnight-900 border border-white/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-terracotta-400" />
                <span className="font-medium text-white">Connection Failed</span>
              </div>
              <p className="text-sm text-gray-400 mb-3">Wallet won&apos;t connect or keeps disconnecting</p>
              <ul className="text-xs text-gray-500 space-y-1">
                <li>• Check if wallet extension is enabled</li>
                <li>• Try refreshing the page</li>
                <li>• Clear browser cache and cookies</li>
                <li>• Try a different browser</li>
              </ul>
            </div>

            <div className="bg-midnight-900 border border-white/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-terracotta-400" />
                <span className="font-medium text-white">Transaction Stuck</span>
              </div>
              <p className="text-sm text-gray-400 mb-3">Transaction is pending or not confirming</p>
              <ul className="text-xs text-gray-500 space-y-1">
                <li>• Check network congestion</li>
                <li>• Verify sufficient balance</li>
                <li>• Try increasing fee if possible</li>
                <li>• Check transaction on explorer</li>
              </ul>
            </div>

            <div className="bg-midnight-900 border border-white/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-terracotta-400" />
                <span className="font-medium text-white">Wrong Network</span>
              </div>
              <p className="text-sm text-gray-400 mb-3">Wallet connected to wrong network</p>
              <ul className="text-xs text-gray-500 space-y-1">
                <li>• Click the &quot;Wrong Network&quot; alert</li>
                <li>• Go to Settings to switch networks</li>
                <li>• Ensure wallet supports network switching</li>
                <li>• Contact support if issue persists</li>
              </ul>
            </div>

            <div className="bg-midnight-900 border border-white/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-terracotta-400" />
                <span className="font-medium text-white">Insufficient Balance</span>
              </div>
              <p className="text-sm text-gray-400 mb-3">Not enough XLM for transaction</p>
              <ul className="text-xs text-gray-500 space-y-1">
                <li>• Add more XLM to your wallet</li>
                <li>• Remember minimum 1 XLM reserve</li>
                <li>• Account for transaction fees</li>
                <li>• Use testnet for testing</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Contact Support */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-white mb-4">Still Need Help?</h2>
          <div className="bg-midnight-900 border border-white/5 rounded-xl p-6">
            <p className="text-gray-400 mb-6">
              Can&apos;t find what you&apos;re looking for? Our support team is here to help you with any issues or questions.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {contactMethods.map((method, index) => (
                <a
                  key={index}
                  href={method.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-4 bg-white/5 rounded-lg hover:bg-white/10 transition-all group"
                >
                  <method.icon className={`h-5 w-5 ${method.color}`} />
                  <div>
                    <div className="font-medium text-white">{method.title}</div>
                    <div className="text-sm text-gray-400">{method.description}</div>
                  </div>
                  <ExternalLink className="h-4 w-4 text-gray-400 ml-auto" />
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* Resources */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-white mb-4">Additional Resources</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <a
              href="https://stellar.org/developers"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-midnight-900 border border-white/5 rounded-xl hover:bg-white/5 transition-all"
            >
              <Book className="h-5 w-5 text-brand-400" />
              <div>
                <div className="font-medium text-white">Stellar Developers</div>
                <div className="text-sm text-gray-400">Official developer documentation</div>
              </div>
              <ExternalLink className="h-4 w-4 text-gray-400 ml-auto" />
            </a>

            <a
              href="https://freighter.app"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-midnight-900 border border-white/5 rounded-xl hover:bg-white/5 transition-all"
            >
              <Wallet className="h-5 w-5 text-brand-400" />
              <div>
                <div className="font-medium text-white">Freighter Wallet</div>
                <div className="text-sm text-gray-400">Download and setup guide</div>
              </div>
              <ExternalLink className="h-4 w-4 text-gray-400 ml-auto" />
            </a>

            <a
              href="https://stellar.expert"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-midnight-900 border border-white/5 rounded-xl hover:bg-white/5 transition-all"
            >
              <Network className="h-5 w-5 text-brand-400" />
              <div>
                <div className="font-medium text-white">Stellar Explorer</div>
                <div className="text-sm text-gray-400">Explore transactions and accounts</div>
              </div>
              <ExternalLink className="h-4 w-4 text-gray-400 ml-auto" />
            </a>

            <a
              href="https://soroban.stellar.org/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-midnight-900 border border-white/5 rounded-xl hover:bg-white/5 transition-all"
            >
              <Book className="h-5 w-5 text-brand-400" />
              <div>
                <div className="font-medium text-white">Soroban Docs</div>
                <div className="text-sm text-gray-400">Smart contract platform documentation</div>
              </div>
              <ExternalLink className="h-4 w-4 text-gray-400 ml-auto" />
            </a>

            <a
              href="https://www.stellar.org/laboratory"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-midnight-900 border border-white/5 rounded-xl hover:bg-white/5 transition-all"
            >
              <Zap className="h-5 w-5 text-brand-400" />
              <div>
                <div className="font-medium text-white">Stellar Laboratory</div>
                <div className="text-sm text-gray-400">Interactive tools for testing</div>
              </div>
              <ExternalLink className="h-4 w-4 text-gray-400 ml-auto" />
            </a>

            <a
              href="https://steexp.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-midnight-900 border border-white/5 rounded-xl hover:bg-white/5 transition-all"
            >
              <Network className="h-5 w-5 text-brand-400" />
              <div>
                <div className="font-medium text-white">Steexp Explorer</div>
                <div className="text-sm text-gray-400">Alternative Stellar blockchain explorer</div>
              </div>
              <ExternalLink className="h-4 w-4 text-gray-400 ml-auto" />
            </a>
          </div>
        </div>

        {/* Testnet Guide */}
        <div className="bg-gradient-to-r from-brand-500/10 to-terracotta-500/10 border border-brand-500/20 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <Zap className="h-5 w-5 text-brand-400" />
            <h3 className="text-lg font-semibold text-white">New to Stellar? Try Testnet First!</h3>
          </div>
          <p className="text-gray-400 mb-4">
            Testnet is a safe environment where you can experiment with ELCARE-HUB using fake tokens. It&apos;s perfect for learning how the platform works without risking real money.
          </p>
          
          <div className="space-y-4 mb-6">
            <div className="bg-white/5 rounded-lg p-4">
              <h4 className="font-medium text-white mb-2">Getting Started with Testnet</h4>
              <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
                <li>Go to Settings and switch to &quot;Stellar Testnet&quot;</li>
                <li>Get free testnet XLM from the Stellar Laboratory</li>
                <li>Connect your wallet to ELCARE-HUB</li>
                <li>Explore the marketplace and test features</li>
                <li>No real money at risk - learn by doing!</li>
              </ol>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white/5 rounded-lg p-4">
                <h5 className="font-medium text-white mb-2">Benefits of Testnet</h5>
                <ul className="text-sm text-gray-400 space-y-1">
                  <li>• Free testnet tokens</li>
                  <li>• Same features as mainnet</li>
                  <li>• No financial risk</li>
                  <li>• Great for learning</li>
                </ul>
              </div>
              <div className="bg-white/5 rounded-lg p-4">
                <h5 className="font-medium text-white mb-2">Testnet vs Mainnet</h5>
                <ul className="text-sm text-gray-400 space-y-1">
                  <li>• Testnet: Fake tokens, safe</li>
                  <li>• Mainnet: Real value, risk</li>
                  <li>• Testnet: Faster resets</li>
                  <li>• Mainnet: Real transactions</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-4">
            <a
              href="https://laboratory.stellar.org/#account-creator?network=test"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-all"
            >
              <Zap className="h-4 w-4" />
              Get Testnet XLM
            </a>
            <a
              href="/settings"
              className="flex items-center justify-center gap-2 px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-all"
            >
              <Settings className="h-4 w-4" />
              Switch to Testnet
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
