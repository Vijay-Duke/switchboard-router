import { DEFAULT_LANG } from "./languages";

// Navigation structure (slugs are shared). Labels are per-language.
const NAV_STRUCTURE = [
  {
    key: "gettingStarted",
    items: [
      { key: "introduction", slug: "" },
      { key: "quickStart", slug: "getting-started/quick-start" },
      { key: "installation", slug: "getting-started/installation" }
    ]
  },
  {
    key: "usingSwitchboard",
    items: [
      { key: "endpoint", slug: "using/endpoint" },
      { key: "providers", slug: "using/providers" },
      { key: "combos", slug: "using/combos" },
      { key: "usage", slug: "using/usage" }
    ]
  },
  {
    key: "clients",
    items: [
      { key: "cliTools", slug: "clients/cli-tools" },
      { key: "openaiCompatible", slug: "clients/openai-compatible" }
    ]
  },
  {
    key: "deployment",
    items: [
      { key: "local", slug: "deployment/local" },
      { key: "docker", slug: "deployment/docker" }
    ]
  },
  {
    key: "help",
    items: [
      { key: "troubleshooting", slug: "troubleshooting" },
      { key: "faq", slug: "faq" }
    ]
  }
];

// Translations for section/item titles (5 langs).
const TRANSLATIONS = {
  en: {
    gettingStarted: "Getting Started",
    introduction: "Introduction",
    quickStart: "Quick Start",
    installation: "Installation",
    usingSwitchboard: "Using Switchboard",
    endpoint: "Endpoint & Keys",
    providers: "Providers",
    combos: "Combos",
    usage: "Usage & Quota",
    clients: "Clients",
    cliTools: "CLI Tools",
    openaiCompatible: "OpenAI-Compatible Clients",
    deployment: "Deployment",
    local: "Local",
    docker: "Docker",
    help: "Help",
    troubleshooting: "Troubleshooting",
    faq: "FAQ",
    goToApp: "Go to App",
    selectLanguage: "Select Language",
    onThisPage: "On this page"
  },
  vi: {
    gettingStarted: "Bắt đầu",
    introduction: "Giới thiệu",
    quickStart: "Bắt đầu nhanh",
    installation: "Cài đặt",
    usingSwitchboard: "Sử dụng Switchboard",
    endpoint: "Endpoint & khóa",
    providers: "Nhà cung cấp",
    combos: "Combo",
    usage: "Sử dụng & quota",
    clients: "Ứng dụng khách",
    cliTools: "Công cụ CLI",
    openaiCompatible: "Ứng dụng tương thích OpenAI",
    deployment: "Triển khai",
    local: "Cục bộ",
    docker: "Docker",
    help: "Trợ giúp",
    troubleshooting: "Khắc phục sự cố",
    faq: "Câu hỏi thường gặp",
    goToApp: "Vào ứng dụng",
    selectLanguage: "Chọn ngôn ngữ",
    onThisPage: "Trên trang này"
  },
  "zh-CN": {
    gettingStarted: "开始使用",
    introduction: "简介",
    quickStart: "快速开始",
    installation: "安装",
    usingSwitchboard: "使用 Switchboard",
    endpoint: "端点与密钥",
    providers: "提供商",
    combos: "组合",
    usage: "用量与配额",
    clients: "客户端",
    cliTools: "CLI 工具",
    openaiCompatible: "OpenAI 兼容客户端",
    deployment: "部署",
    local: "本地",
    docker: "Docker",
    help: "帮助",
    troubleshooting: "故障排查",
    faq: "常见问题",
    goToApp: "前往应用",
    selectLanguage: "选择语言",
    onThisPage: "本页内容"
  },
  es: {
    gettingStarted: "Comenzar",
    introduction: "Introducción",
    quickStart: "Inicio rápido",
    installation: "Instalación",
    usingSwitchboard: "Usar Switchboard",
    endpoint: "Endpoint y claves",
    providers: "Proveedores",
    combos: "Combos",
    usage: "Uso y cuota",
    clients: "Clientes",
    cliTools: "Herramientas CLI",
    openaiCompatible: "Clientes compatibles con OpenAI",
    deployment: "Despliegue",
    local: "Local",
    docker: "Docker",
    help: "Ayuda",
    troubleshooting: "Solución de problemas",
    faq: "Preguntas frecuentes",
    goToApp: "Ir a la app",
    selectLanguage: "Seleccionar idioma",
    onThisPage: "En esta página"
  },
  ja: {
    gettingStarted: "はじめに",
    introduction: "概要",
    quickStart: "クイックスタート",
    installation: "インストール",
    usingSwitchboard: "Switchboard の使い方",
    endpoint: "エンドポイントとキー",
    providers: "プロバイダー",
    combos: "コンボ",
    usage: "使用量とクォータ",
    clients: "クライアント",
    cliTools: "CLI ツール",
    openaiCompatible: "OpenAI 互換クライアント",
    deployment: "デプロイ",
    local: "ローカル",
    docker: "Docker",
    help: "ヘルプ",
    troubleshooting: "トラブルシューティング",
    faq: "よくある質問",
    goToApp: "アプリへ",
    selectLanguage: "言語を選択",
    onThisPage: "このページ"
  }
};

// Translate one key for given language with fallback to default.
export function t(lang, key) {
  return TRANSLATIONS[lang]?.[key] || TRANSLATIONS[DEFAULT_LANG][key] || key;
}

// Build localized navigation for sidebar.
export function getNavigation(lang) {
  return NAV_STRUCTURE.map(section => ({
    key: section.key,
    title: t(lang, section.key),
    items: section.items.map(item => ({
      key: item.key,
      slug: item.slug,
      title: t(lang, item.key)
    }))
  }));
}

// Static config (logo, urls, default English nav for backward compatibility).
export const DOCS_CONFIG = {
  title: "Switchboard Documentation",
  description: "Local AI model routing gateway",
  logo: "Switchboard",
  appUrl: "",
  githubUrl: "",
  navigation: getNavigation(DEFAULT_LANG)
};
