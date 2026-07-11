"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config";
import { reportClientError } from "@/shared/utils/clientFeedback";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];

const TRANSLATABLE_ATTRIBUTES = {
  "data-i18n-placeholder": "placeholder",
  "data-i18n-title": "title",
  "data-i18n-aria-label": "aria-label",
  "data-i18n-alt": "alt",
};
const AUTO_TRANSLATABLE_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];

// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Load translation map
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }
  
  try {
    const response = await fetch(`/i18n/literals/${locale}.json`);
    translationMap = await response.json();
  } catch (err) {
    reportClientError("Failed to load translations:", err);
    translationMap = {};
  }
}

// Translate text - exported for use in components
export function translate(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (currentLocale === "en") return text;
  return translationMap[trimmed] || text;
}

// Get current locale - exported for use in components
export function getCurrentLocale() {
  return currentLocale;
}

// Register callback for locale changes
export function onLocaleChange(callback) {
  reloadCallbacks.push(callback);
  return () => {
    reloadCallbacks = reloadCallbacks.filter(cb => cb !== callback);
  };
}

// Process text node
function processTextNode(node) {
  if (!node.nodeValue || !node.nodeValue.trim()) return;
  
  // Skip if parent is script, style, code, or structural elements
  const parent = node.parentElement;
  if (!parent) return;
  
  if (isI18nSkipped(parent)) return;
  
  const tagName = parent.tagName?.toLowerCase();
  
  // Skip elements that don't allow text nodes
  const skipTags = [
    "script", "style", "code", "pre",
    "colgroup", "table", "thead", "tbody", "tfoot", "tr",
  ];
  
  if (skipTags.includes(tagName)) return;
  
  // Store original text if not already stored
  if (!node._originalText) {
    node._originalText = node.nodeValue;
  }
  
  // Use original text for translation
  const original = node._originalText;
  const translated = translate(original);
  
  // Only update if different to avoid unnecessary DOM mutations
  if (translated !== node.nodeValue) {
    node.nodeValue = translated;
  }
}

function isI18nSkipped(element) {
  let current = element;
  while (current) {
    if (current.hasAttribute?.("data-i18n-skip")) return true;
    current = current.parentElement;
  }
  return false;
}

function processI18nAttributes(element) {
  if (!element || isI18nSkipped(element)) return;

  const textKey = element.getAttribute?.("data-i18n");
  if (textKey && element.children?.length === 0) {
    const translated = translate(textKey);
    if (element.textContent !== translated) element.textContent = translated;
  }

  const originalAttributes = element._originalI18nAttributes || {};
  const lastTranslatedAttributes = element._lastI18nAttributeValues || {};
  for (const targetAttribute of AUTO_TRANSLATABLE_ATTRIBUTES) {
    const sourceAttribute = Object.keys(TRANSLATABLE_ATTRIBUTES)
      .find((attribute) => TRANSLATABLE_ATTRIBUTES[attribute] === targetAttribute);
    const markedSource = sourceAttribute ? element.getAttribute?.(sourceAttribute) : null;
    const current = element.getAttribute?.(targetAttribute);
    if (!markedSource && current == null) continue;

    let source = markedSource || originalAttributes[targetAttribute];
    if (markedSource) {
      source = markedSource;
    } else if (source === undefined) {
      source = current;
    } else if (current !== lastTranslatedAttributes[targetAttribute] && current !== source) {
      // React may have supplied a new English attribute value since the last pass.
      source = current;
    }
    if (!source) continue;

    const translated = translate(source);
    if (current !== translated) {
      element.setAttribute(targetAttribute, translated);
    }
    originalAttributes[targetAttribute] = source;
    lastTranslatedAttributes[targetAttribute] = translated;
  }
  element._originalI18nAttributes = originalAttributes;
  element._lastI18nAttributeValues = lastTranslatedAttributes;
}

// Process all text nodes in element
function processElement(element) {
  if (!element) return;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let node;
  const nodesToProcess = [];
  
  // Collect all nodes first to avoid live collection issues
  while ((node = walker.nextNode())) {
    nodesToProcess.push(node);
  }
  
  // Process collected nodes
  nodesToProcess.forEach(processTextNode);

  processI18nAttributes(element);
  element.querySelectorAll?.("*")?.forEach(processI18nAttributes);
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;
  
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Process existing DOM
  processElement(document.body);
  
  // Watch for new nodes
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes") {
        processI18nAttributes(mutation.target);
        return;
      }
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processElement(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        }
      });
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-i18n",
      "data-i18n-skip",
      "data-i18n-placeholder",
      "data-i18n-title",
      "data-i18n-aria-label",
      "data-i18n-alt",
      "placeholder",
      "title",
      "aria-label",
      "alt",
    ],
  });
}

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Notify all registered callbacks
  reloadCallbacks.forEach(callback => callback());
  
  // Re-process entire DOM (will use stored original text)
  processElement(document.body);
}
