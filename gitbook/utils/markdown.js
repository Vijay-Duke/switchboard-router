import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { BookOpen, Rocket, Terminal, Monitor, FolderOpen, HelpCircle, MessageCircle, Mouse, Folder, Lock, Zap, Smartphone, Lightbulb, AlertTriangle, CheckCircle, ArrowRight, Layers, Plug, Cloud, Wallet, Gift, GitBranch, BarChart3, Code2, Sparkles, Server, PartyPopper, Siren, Link2, Target, Heart, Check, Home, Package, Wrench, OctagonX, Search, Globe, Container } from "lucide-react";

const PAGE_ICONS = {
  "Welcome to Switchboard": BookOpen,
  "Introduction": BookOpen,
  "Getting Started": Rocket,
  "Quick Start": Rocket,
  "Installation": Terminal,
  "Providers": Layers,
  "Subscription (Maximize)": Sparkles,
  "Cheap (Backup)": Wallet,
  "Free (Fallback)": Gift,
  "Features": Zap,
  "Smart Routing": GitBranch,
  "Combos & Fallback": Layers,
  "Quota Tracking": BarChart3,
  "Integration": Plug,
  "Claude Code": Code2,
  "OpenAI Codex": Code2,
  "Cursor": Code2,
  "Cline": Code2,
  "Roo": Code2,
  "Continue": Code2,
  "Other Tools": Plug,
  "Deployment": Cloud,
  "Localhost": Monitor,
  "Cloud (VPS/Docker)": Server,
  "Troubleshooting": HelpCircle,
  "FAQ": MessageCircle,
  "Frequently Asked Questions": MessageCircle
};

const ICON_MAP = {
  "terminal": Terminal,
  "monitor": Monitor,
  "mouse": Mouse,
  "folder": Folder,
  "lock": Lock,
  "zap": Zap,
  "smartphone": Smartphone,
  "lightbulb": Lightbulb,
  "alert-triangle": AlertTriangle,
  "check-circle": CheckCircle,
  "arrow-right": ArrowRight,
};

// Emoji to lucide icon mapping (auto-converted in markdown)
const EMOJI_ICON_MAP = {
  "✅": { Icon: CheckCircle, color: "text-green-600" },
  "✓": { Icon: Check, color: "text-green-600" },
  "❌": { Icon: AlertTriangle, color: "text-red-500" },
  "⚠️": { Icon: AlertTriangle, color: "text-yellow-600" },
  "⚠": { Icon: AlertTriangle, color: "text-yellow-600" },
  "🚨": { Icon: Siren, color: "text-red-500" },
  "🛑": { Icon: OctagonX, color: "text-red-500" },
  "💡": { Icon: Lightbulb, color: "text-yellow-500" },
  "🔄": { Icon: GitBranch, color: "text-teal-600" },
  "🚀": { Icon: Rocket, color: "text-teal-600" },
  "⚡": { Icon: Zap, color: "text-yellow-500" },
  "🔌": { Icon: Plug, color: "text-teal-600" },
  "☁️": { Icon: Cloud, color: "text-blue-500" },
  "☁": { Icon: Cloud, color: "text-blue-500" },
  "📦": { Icon: Package, color: "text-teal-600" },
  "💰": { Icon: Wallet, color: "text-green-600" },
  "🎁": { Icon: Gift, color: "text-pink-500" },
  "📊": { Icon: BarChart3, color: "text-teal-600" },
  "💻": { Icon: Code2, color: "text-gray-700" },
  "✨": { Icon: Sparkles, color: "text-teal-600" },
  "🖥️": { Icon: Server, color: "text-gray-700" },
  "🖥": { Icon: Server, color: "text-gray-700" },
  "📖": { Icon: BookOpen, color: "text-teal-600" },
  "🔒": { Icon: Lock, color: "text-gray-700" },
  "➡️": { Icon: ArrowRight, color: "text-teal-600" },
  "📱": { Icon: Smartphone, color: "text-teal-600" },
  "📂": { Icon: Folder, color: "text-teal-600" },
  "📁": { Icon: Folder, color: "text-teal-600" },
  "🖱️": { Icon: Mouse, color: "text-teal-600" },
  "🎉": { Icon: PartyPopper, color: "text-pink-500" },
  "🔗": { Icon: Link2, color: "text-blue-500" },
  "🎯": { Icon: Target, color: "text-red-500" },
  "❤": { Icon: Heart, color: "text-red-500" },
  "❤️": { Icon: Heart, color: "text-red-500" },
  "🏠": { Icon: Home, color: "text-teal-600" },
  "🔧": { Icon: Wrench, color: "text-gray-700" },
  "🔍": { Icon: Search, color: "text-gray-700" },
  "🌐": { Icon: Globe, color: "text-blue-500" },
  "🐳": { Icon: Container, color: "text-blue-500" }
};

const EMOJI_REGEX = new RegExp(`^(${Object.keys(EMOJI_ICON_MAP).map(e => e.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")).join("|")})\\s*`);

export function parseMarkdown(content) {
  return content;
}

// Unicode-aware slugify: keeps letters/numbers from any language (Vietnamese, Chinese, Japanese, etc.)
export function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/^-+|-+$/g, "");
}

// Extract leading emoji from heading children and replace with lucide icon
function renderHeadingWithEmoji(tag, children, props) {
  const Tag = tag;
  const text = (Array.isArray(children) ? children : [children])
    .map(c => (typeof c === "string" ? c : ""))
    .join("");
  const emojiMatch = text.match(EMOJI_REGEX);
  const textForId = emojiMatch ? text.slice(emojiMatch[0].length).trim() : text;
  const id = slugify(textForId);
  if (emojiMatch) {
    const { Icon, color } = EMOJI_ICON_MAP[emojiMatch[1]];
    const rest = text.slice(emojiMatch[0].length);
    return (
      <Tag id={id} {...props}>
        <Icon className={`inline-block mr-2 align-[-0.15em] w-[1em] h-[1em] ${color}`} />
        {rest}
      </Tag>
    );
  }
  return <Tag id={id} {...props}>{children}</Tag>;
}

export function MarkdownRenderer({ content }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        skipHtml
        components={{
        h1: ({ node, children, ...props }) => {
          const text = children?.toString() || "";
          const IconComponent = PAGE_ICONS[text];
          const id = slugify(text);
          
          return (
            <h1 id={id} {...props}>
              {IconComponent && <IconComponent className="inline-block mr-3" />}
              {children}
            </h1>
          );
        },
        h2: ({ node, children, ...props }) => renderHeadingWithEmoji("h2", children, props),
        h3: ({ node, children, ...props }) => renderHeadingWithEmoji("h3", children, props),
        li: ({ node, children, ...props }) => {
          // Extract text from children (handle React elements)
          const extractText = (child) => {
            if (typeof child === 'string') return child;
            if (Array.isArray(child)) return child.map(extractText).join('');
            if (child?.props?.children) return extractText(child.props.children);
            return '';
          };
          
          const text = extractText(children);
          const iconMatch = text.match(/^\[icon:([a-z-]+)\]\s*(.*)$/);
          
          if (iconMatch) {
            const iconName = iconMatch[1];
            const restText = iconMatch[2];
            const IconComponent = ICON_MAP[iconName];
            
            return (
              <li {...props}>
                {IconComponent && <IconComponent className="inline-block mr-2 w-4 h-4 text-teal-600" />}
                {restText}
              </li>
            );
          }

          // Auto-convert leading emoji to lucide icon
          const emojiMatch = text.match(EMOJI_REGEX);
          if (emojiMatch) {
            const { Icon, color } = EMOJI_ICON_MAP[emojiMatch[1]];
            const restText = text.slice(emojiMatch[0].length);
            return (
              <li {...props}>
                <Icon className={`inline-block mr-2 w-4 h-4 ${color}`} />
                {restText}
              </li>
            );
          }
          
          return <li {...props}>{children}</li>;
        },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function extractHeadings(content) {
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  const headings = [];
  let match;

  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].replace(EMOJI_REGEX, "").trim();
    const id = slugify(text);
    
    headings.push({
      level,
      text,
      id
    });
  }

  return headings;
}
