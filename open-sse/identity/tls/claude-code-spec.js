// Captured from Claude Code 2.1.258 native darwin-arm64 binary.
export const CLAUDE_CODE_TLS_SPEC_REV = "2.1.258";
export const CLAUDE_CODE_ALPN = Object.freeze(["http/1.1"]);

export const CLAUDE_CODE_CIPHER_SUITES = Object.freeze([
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
  "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
  "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA",
  "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
  "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA",
  "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
  "TLS_RSA_WITH_AES_128_GCM_SHA256",
  "TLS_RSA_WITH_AES_256_GCM_SHA384",
  "TLS_RSA_WITH_AES_128_CBC_SHA",
  "TLS_RSA_WITH_AES_256_CBC_SHA",
]);

export const CLAUDE_CODE_EXTENSIONS = Object.freeze([
  "server_name",
  "extended_master_secret",
  "renegotiation_info",
  "supported_groups:x25519_mlkem768,x25519,secp256r1,secp384r1",
  "ec_point_formats:uncompressed",
  "session_ticket",
  "alpn:http/1.1",
  "status_request",
  "signature_algorithms:ecdsa_secp256r1_sha256,rsa_pss_rsae_sha256,rsa_pkcs1_sha256,ecdsa_secp384r1_sha384,rsa_pss_rsae_sha384,rsa_pkcs1_sha384,rsa_pss_rsae_sha512,rsa_pkcs1_sha512,rsa_pkcs1_sha1",
  "signed_certificate_timestamp",
  "key_share:x25519_mlkem768",
  "psk_key_exchange_modes:psk_dhe_ke",
  "supported_versions:TLS1.3,TLS1.2",
]);
