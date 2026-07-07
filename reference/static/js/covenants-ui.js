(function () {
  const $ = (id) => document.getElementById(id);

  const UI = {
    sdkStatus: $("ccSdkStatus"),
    sdkVersion: $("ccSdkVersion"),
    surfaceOutput: $("ccSurfaceOutput"),
    surfaceCovenantId: $("ccSurfaceCovenantId"),
    executionMode: $("ccExecutionMode"),
    contractType: $("ccContractType"),
    network: $("ccNetwork"),
    ownerMode: $("ccOwnerMode"),
    ownerIdentifier: $("ccOwnerIdentifier"),
    initialKas: $("ccInitialKas"),
    displayName: $("ccDisplayName"),
    previewPacket: $("ccPreviewPacket"),
    buildPreview: $("ccBuildPreview"),
    refreshSdk: $("ccRefreshSdk"),
    proofPacketExportPanel: null,
    proofPacketExportStatus: null,
    proofPacketCopy: null,
    proofPacketDownload: null,
    inspectRefresh: null,
    inspectStatus: null,
    inspectSummary: null,
    inspectRows: null,
    inspectJson: null,
    inspectPrev: null,
    inspectNext: null,
    inspectPageInfo: null,
    inspectSort: null,
    registryRefresh: null,
    registryStatus: null,
    registrySummary: null,
    registryRows: null,
    registryJson: null,
    profileSpecificPanel: null,
    profileSpecificFields: null,
    profileSpecificSummary: null,
    protectKasAmountKas: $("ccProtectKasAmountKas"),
    protectKasDestinationAddress: $("ccProtectKasDestinationAddress"),
    protectKasBuildButton: $("ccProtectKasBuildButton"),
    protectKasSubmitButton: $("ccProtectKasSubmitButton"),
    protectKasReleaseOutpoint: $("ccProtectKasReleaseOutpoint"),
    protectKasReleaseCovenantId: $("ccProtectKasReleaseCovenantId"),
    protectKasReleaseBuildButton: $("ccProtectKasReleaseBuildButton"),
    protectKasReleaseSubmitButton: $("ccProtectKasReleaseSubmitButton"),
    protectKasStatus: $("ccProtectKasStatus"),
    protectKasProof: $("ccProtectKasProof")
  };

  const TEMPLATE_REGISTRY_URL = "/static/covenants/template-registry.v1.json";
  const templateRegistryState = {
    loaded: false,
    data: null,
    error: null
  };

  const inspectionPaginationState = {
    limit: 20,
    offset: 0,
    sortMode: "amount_desc_outpoint",
    last: null
  };

  function setText(el, value) {
    if (el) el.textContent = String(value == null ? "" : value);
  }

  function readField(el) {
    return String(el && el.value ? el.value : "").trim();
  }

  function safeType(value) {
    return typeof value;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function shortText(value, head, tail) {
    const text = String(value == null ? "" : value);
    const h = Number.isFinite(head) ? head : 12;
    const t = Number.isFinite(tail) ? tail : 10;
    if (text.length <= h + t + 3) return text;
    return `${text.slice(0, h)}…${text.slice(-t)}`;
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function boolLabel(value) {
    return value === true ? "yes" : value === false ? "no" : "unknown";
  }

  function networkList(value) {
    return asArray(value).join(", ") || "none";
  }

  function stableJson(value) {
    const seen = new WeakSet();
    const normalize = function (input) {
      if (input === null || typeof input !== "object") return input;
      if (seen.has(input)) return "[Circular]";
      seen.add(input);
      if (Array.isArray(input)) return input.map(normalize);
      return Object.keys(input).sort().reduce(function (out, key) {
        out[key] = normalize(input[key]);
        return out;
      }, {});
    };
    return JSON.stringify(normalize(value));
  }

  async function sha256Text(value) {
    if (!window.crypto || !window.crypto.subtle || typeof TextEncoder !== "function") {
      return "sha256_unavailable_in_browser";
    }
    const bytes = new TextEncoder().encode(String(value == null ? "" : value));
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }


  function normalizeUnsignedIntegerString(value, fallback) {
    const text = String(value == null ? "" : value).trim();
    if (/^[0-9]+$/.test(text)) return text.replace(/^0+(?=\d)/, "") || "0";
    return fallback == null ? null : String(fallback);
  }

  function normalizeDecimals(value) {
    const text = String(value == null ? "" : value).trim();
    if (!/^[0-9]+$/.test(text)) return 0;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(Math.floor(parsed), 18);
  }

  function formatRawTokenAmountHuman(amountRaw, decimals) {
    const raw = normalizeUnsignedIntegerString(amountRaw, "0");
    const places = normalizeDecimals(decimals);
    if (places <= 0) return raw;
    const padded = raw.padStart(places + 1, "0");
    const whole = padded.slice(0, -places) || "0";
    const fractional = padded.slice(-places).replace(/0+$/, "");
    return fractional ? `${whole}.${fractional}` : whole;
  }

  function scriptPreviewValue(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return null;
    if (typeof value.value === "string") return value.value;
    if (typeof value.preview === "string") return value.preview;
    if (value.fields && typeof value.fields.script === "string") return value.fields.script;
    if (value.preview && typeof value.preview === "object") return scriptPreviewValue(value.preview);
    return null;
  }

  function rowLiveScriptPublicKeyScript(row) {
    if (row && typeof row.script_public_key_script === "string" && row.script_public_key_script) {
      return row.script_public_key_script;
    }

    const probes = row && row.debug_entry_shape && row.debug_entry_shape.accessor_probe && Array.isArray(row.debug_entry_shape.accessor_probe.entry)
      ? row.debug_entry_shape.accessor_probe.entry
      : [];
    const direct = probes.find(function (probe) {
      return probe && probe.path === "reference.entry.scriptPublicKey.script";
    });
    const fromDirect = direct ? scriptPreviewValue(direct.preview) : null;
    if (fromDirect) return fromDirect;

    const jsonProbe = probes.find(function (probe) {
      return probe && probe.path === "reference.entry.scriptPublicKey.toJSON()";
    });
    const fromJson = jsonProbe ? scriptPreviewValue(jsonProbe.preview) : null;
    if (fromJson) return fromJson;

    const spkProbe = row && row.debug_entry_shape && row.debug_entry_shape.script_public_key_probe
      ? row.debug_entry_shape.script_public_key_probe.entry_script_public_key_preview
      : null;
    return scriptPreviewValue(spkProbe);
  }

  function readUnlockedKeyringShape() {
    try {
      const raw = window.sessionStorage ? window.sessionStorage.getItem("cw_keyring_session") : null;
      const parsed = raw ? JSON.parse(raw) : null;
      const priv0Hex = String(parsed && parsed.priv0_hex ? parsed.priv0_hex : "").trim();
      if (!/^[0-9a-f]{64}$/i.test(priv0Hex)) {
        return { ok: false, reason: "unlocked_keyring_priv0_hex_missing", source: "sessionStorage.cw_keyring_session.priv0_hex" };
      }
      return {
        ok: true,
        source: "sessionStorage.cw_keyring_session.priv0_hex",
        wallet_id: parsed.wallet_id || null,
        address0: parsed.address0 || null,
        priv0_hex: priv0Hex
      };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e), source: "sessionStorage.cw_keyring_session.priv0_hex" };
    }
  }

  async function fetchWalletStatusForReconciliation() {
    try {
      const response = await fetch("/api/wallet/status", {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      const body = await response.json().catch(function () { return { ok: false, reason: "invalid_json_response" }; });
      return { http_status: response.status, body };
    } catch (e) {
      return { http_status: 0, body: { ok: false, reason: String(e && e.message ? e.message : e) } };
    }
  }

  async function fetchInspectionForAddress(address, debugEntryShape) {
    const url = `/api/covenants/utxos?address=${encodeURIComponent(address)}${debugEntryShape ? "&debug_entry_shape=1" : ""}`;
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "application/json" }
    });
    const body = await response.json().catch(function () { return { ok: false, reason: "invalid_json_response" }; });
    return { http_status: response.status, body };
  }

  function resolveOmaL1DecodedFields(decodedFields, liveCovenantId) {
    const resolved = Object.assign({}, decodedFields || {});
    const placeholder = resolved.asset_covenant_id === "output.covenant.covenantId";
    if (placeholder) resolved.asset_covenant_id = liveCovenantId || null;
    resolved.asset_covenant_id_source = placeholder ? "matched_live_row.covenant_id" : "decoded_fields.asset_covenant_id";
    resolved.asset_covenant_id_placeholder_resolved = placeholder;
    return resolved;
  }

  function omaL1DisplayAmounts(fields) {
    const decimals = normalizeDecimals(fields && fields.decimals);
    const out = { decimals };
    if (fields && fields.amount_raw != null) {
      out.amount_raw = normalizeUnsignedIntegerString(fields.amount_raw, "0");
      out.amount_human = formatRawTokenAmountHuman(out.amount_raw, decimals);
    }
    if (fields && fields.issued_supply_raw != null) {
      out.issued_supply_raw = normalizeUnsignedIntegerString(fields.issued_supply_raw, "0");
      out.issued_supply_human = formatRawTokenAmountHuman(out.issued_supply_raw, decimals);
    }
    if (fields && fields.max_supply_raw != null) {
      out.max_supply_raw = normalizeUnsignedIntegerString(fields.max_supply_raw, "0");
      out.max_supply_human = formatRawTokenAmountHuman(out.max_supply_raw, decimals);
    }
    return out;
  }

  function omaL1RowOutpointText(row) {
    return row && row.outpoint && row.outpoint.text ? String(row.outpoint.text) : "";
  }

  function omaL1DedupeRowsByOutpoint(rows) {
    const seen = new Set();
    const out = [];
    asArray(rows).forEach(function (row) {
      const key = omaL1RowOutpointText(row) || `${row && row.covenant_id ? row.covenant_id : ""}:${row && row.classification ? row.classification : ""}:${out.length}`;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      out.push(row);
    });
    return out;
  }

  function omaL1ParseOutpointText(text) {
    const value = String(text || "").trim();
    const match = value.match(/^([0-9a-f]{64}):(\d+)$/i);
    if (!match) return { transaction_id: null, index: null, text: value || null };
    return { transaction_id: match[1].toLowerCase(), index: Number(match[2]), text: `${match[1].toLowerCase()}:${match[2]}` };
  }

  function sameKaspaAddressText(a, b) {
    return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  }

  function serverTrackedOmaL1HolderRow(tok) {
    if (!tok || tok.asset_kind !== "oma_l1_covenant_token") return null;
    if (tok.verification_status !== "live_chain_recomputed_p2sh_match") return null;
    const holderOutpoint = String(tok.holder_outpoint || "").trim();
    const covenantId = String(tok.asset_covenant_id || "").trim().toLowerCase();
    if (!holderOutpoint || !covenantId) return null;
    const symbol = String(tok.token_symbol || "OMA L1");
    const decimals = Number.isFinite(Number(tok.decimals)) ? Number(tok.decimals) : 0;
    const amountRaw = String(tok.amount_raw || "0");
    const amountHuman = String(tok.amount_human || amountRaw);
    return {
      address_source: "server_tracked_holder_address",
      inspection_address: tok.holder_address || null,
      outpoint: omaL1ParseOutpointText(holderOutpoint),
      amount_sompi: tok.holder_carrier_sompi || null,
      amount_kas: tok.holder_carrier_kas || "0",
      covenant_present: true,
      covenant_id: covenantId,
      covenant_path: "server_tracked_record_live_verified",
      classification: "verified_oma_l1_holder_token",
      label: `Verified ${symbol} holder token`,
      registry_match: true,
      proof_status: tok.verification_status,
      token: true,
      warning: "Verified OMA L1 holder token from server-tracked live-chain verification. Carrier KAS remains blocked from normal KAS send.",
      warning_class: "verified_oma_l1_holder_token_normal_send_blocked",
      normal_send_eligible: false,
      verified_oma_l1_state: {
        proof_kind: "oma_l1_server_tracked_holder_row_v1",
        verification_status: "verified_p2sh_state_envelope_match",
        role: "holder",
        live_script_public_key_script: null,
        generated_script_public_key_script: null,
        known_target_script: null,
        script_matches_generated_proof_packet: true,
        script_matches_known_live_target: true,
        live_asset_covenant_id: covenantId,
        live_script_public_key_source: "server_tracked_record_live_verified",
        live_script_public_key_json_sha256: tok.holder_script_public_key_json_sha256 || null,
        proof_packet_asset_covenant_id_placeholder: null,
        decoded_fields: {
          role: "holder",
          token_name: tok.token_name || symbol,
          token_symbol: symbol,
          amount_raw: amountRaw,
          amount_human: amountHuman,
          decimals,
          owner_identifier: tok.owner_identifier || null,
          asset_covenant_id: covenantId,
          normal_send_eligible: false,
          token_transfer_enabled: tok.token_transfer_enabled === true
        },
        display_amounts: {
          amount_raw: amountRaw,
          amount_human: amountHuman,
          decimals
        },
        token_symbol: symbol,
        token_name: tok.token_name || symbol,
        holder_address: tok.holder_address || null,
        holder_outpoint: holderOutpoint,
        holder_carrier_sompi: tok.holder_carrier_sompi || null,
        holder_carrier_kas: tok.holder_carrier_kas || null,
        controller_address: tok.controller_address || null,
        controller_outpoint: tok.controller_outpoint || null,
        controller_state_schema: tok.controller_state_schema || null,
        holder_state_schema: tok.holder_state_schema || null,
        issuer_identifier: tok.issuer_identifier || null,
        max_supply_raw: tok.max_supply_raw || null,
        max_supply_human: tok.max_supply_human || null,
        issued_supply_raw: tok.issued_supply_raw || null,
        issued_supply_human: tok.issued_supply_human || null,
        redeem_script_hex_sha256: tok.holder_redeem_script_hex_sha256 || null,
        p2sh_script_public_key_json_sha256: tok.holder_script_public_key_json_sha256 || null,
        carrier_kas_is_not_token_amount: true,
        controller_reference_display_rule: "controller outpoint is verification metadata for this holder row; it is not rendered as a wallet-held controller row unless the active wallet is the issuer",
        token_amount_source: "server-tracked decoded oma_l1_token_state_v1.amount_raw, not carrier KAS amount",
        human_amount_display_rule: "amount_human = amount_raw / 10^decimals; display only; amount_raw remains canonical"
      }
    };
  }

  function serverTrackedOmaL1ControllerRow(tok) {
    if (!tok || tok.asset_kind !== "oma_l1_covenant_token") return null;
    if (tok.verification_status !== "live_chain_recomputed_p2sh_match") return null;
    const controllerOutpoint = String(tok.controller_outpoint || "").trim();
    const covenantId = String(tok.asset_covenant_id || "").trim().toLowerCase();
    if (!controllerOutpoint || !covenantId) return null;
    const symbol = String(tok.token_symbol || "OMA L1");
    const decimals = normalizeDecimals(tok.decimals);
    const maxSupplyRaw = normalizeUnsignedIntegerString(tok.max_supply_raw, null);
    const issuedSupplyRaw = normalizeUnsignedIntegerString(tok.issued_supply_raw, null);
    const controllerStateSchema = String(tok.controller_state_schema || "oma_l1_token_controller_state_v1");
    const holderStateSchema = String(tok.holder_state_schema || "oma_l1_token_state_v1");
    const displayAmounts = omaL1DisplayAmounts({
      decimals,
      max_supply_raw: maxSupplyRaw,
      issued_supply_raw: issuedSupplyRaw
    });
    return {
      address_source: "server_tracked_controller_address",
      inspection_address: tok.controller_address || null,
      outpoint: omaL1ParseOutpointText(controllerOutpoint),
      amount_sompi: tok.controller_carrier_sompi || null,
      amount_kas: tok.controller_carrier_kas || "0",
      covenant_present: true,
      covenant_id: covenantId,
      covenant_path: "server_tracked_record_live_verified",
      classification: "verified_oma_l1_controller_state",
      label: `Verified ${symbol} controller`,
      registry_match: true,
      proof_status: tok.verification_status,
      token: false,
      warning: "Verified OMA L1 controller state from server-tracked live-chain verification. Controller carrier KAS remains blocked from normal KAS send.",
      warning_class: "verified_oma_l1_controller_state_normal_send_blocked",
      normal_send_eligible: false,
      verified_oma_l1_state: {
        proof_kind: "oma_l1_server_tracked_controller_row_v1",
        verification_status: "verified_p2sh_state_envelope_match",
        role: "controller",
        live_script_public_key_script: null,
        generated_script_public_key_script: null,
        known_target_script: null,
        script_matches_generated_proof_packet: true,
        script_matches_known_live_target: true,
        live_asset_covenant_id: covenantId,
        live_script_public_key_source: "server_tracked_record_live_verified",
        live_script_public_key_json_sha256: tok.controller_script_public_key_json_sha256 || null,
        proof_packet_asset_covenant_id_placeholder: null,
        decoded_fields: {
          role: "controller",
          token_name: tok.token_name || symbol,
          token_symbol: symbol,
          decimals,
          max_supply_raw: maxSupplyRaw,
          issued_supply_raw: issuedSupplyRaw,
          transfer_rule: tok.transfer_rule || null,
          policy_hash: tok.policy_hash || null,
          issuer_identifier: tok.issuer_identifier || null,
          controller_state_schema: controllerStateSchema,
          holder_state_schema: holderStateSchema,
          asset_covenant_id: covenantId,
          controller_address: tok.controller_address || null,
          normal_send_eligible: false,
          token_transfer_enabled: false
        },
        display_amounts: displayAmounts,
        token_symbol: symbol,
        token_name: tok.token_name || symbol,
        controller_address: tok.controller_address || null,
        controller_outpoint: controllerOutpoint,
        controller_carrier_sompi: tok.controller_carrier_sompi || null,
        controller_carrier_kas: tok.controller_carrier_kas || null,
        redeem_script_hex_sha256: tok.controller_redeem_script_hex_sha256 || null,
        p2sh_script_public_key_json_sha256: tok.controller_script_public_key_json_sha256 || null,
        carrier_kas_is_not_token_amount: true,
        token_amount_source: "controller policy state; carrier KAS is not token amount",
        human_amount_display_rule: "controller output is policy/control state, not holder token balance"
      }
    };
  }

  function activeWalletIsOmaL1Issuer(tok, activeWalletAddress) {
    if (!tok || !activeWalletAddress) return false;
    return sameKaspaAddressText(tok.issuer_identifier, activeWalletAddress);
  }

  function serverTrackedOmaL1Rows(tok, activeWalletAddress) {
    const rows = [];
    if (activeWalletIsOmaL1Issuer(tok, activeWalletAddress)) {
      rows.push(serverTrackedOmaL1ControllerRow(tok));
    }
    rows.push(serverTrackedOmaL1HolderRow(tok));
    return rows.filter(Boolean);
  }

  async function buildServerTrackedOmaL1InspectionReconciliation() {
    try {
      const response = await fetch("/api/wallet/holdings?strict=1", {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      const body = await response.json().catch(function () { return { ok: false, reason: "invalid_json_response" }; });
      const oma = body && body.oma_l1 ? body.oma_l1 : null;
      const tokens = oma && Array.isArray(oma.tokens) ? oma.tokens : [];
      const activeWalletAddress = body && body.address ? String(body.address) : "";
      const rows = omaL1DedupeRowsByOutpoint(tokens.flatMap(function (tok) { return serverTrackedOmaL1Rows(tok, activeWalletAddress); }));
      return {
        ok: response.status === 200 && oma && oma.source === "server_tracked_record_live_verified",
        reconciliation_kind: "oma_l1_server_tracked_holdings_reconciliation_v1",
        application_status: "read_only_server_tracked_live_verified",
        http_status: response.status,
        source: oma ? oma.source : null,
        stored_record_drift_allowed: oma ? oma.stored_record_drift_allowed === true : null,
        verification_rule: oma ? oma.verification_rule : null,
        tracked_record_count: oma ? oma.tracked_record_count : null,
        token_count: tokens.length,
        active_wallet_address: activeWalletAddress,
        controller_rows_visible_only_for_active_issuer: true,
        verified_rows: rows.length,
        rows,
        private_key_printed: false,
        unsigned_safe_json_printed: false,
        signed_transaction_printed: false,
        submit_token_printed: false,
        submit_called: false,
        signing_enabled: false,
        broadcasting_enabled: false,
        minting_enabled: false
      };
    } catch (e) {
      return {
        ok: false,
        reconciliation_kind: "oma_l1_server_tracked_holdings_reconciliation_v1",
        application_status: "read_only_server_tracked_lookup_failed_closed",
        reason: String(e && e.message ? e.message : e),
        verified_rows: 0,
        rows: [],
        private_key_printed: false,
        unsigned_safe_json_printed: false,
        signed_transaction_printed: false,
        submit_token_printed: false,
        submit_called: false,
        signing_enabled: false,
        broadcasting_enabled: false,
        minting_enabled: false
      };
    }
  }

  function templateById(registry, templateId) {
    const templates = registry && Array.isArray(registry.templates) ? registry.templates : [];
    return templates.find(function (template) {
      return template && template.template_id === templateId;
    }) || null;
  }

  function templateForContractType(type) {
    const registry = templateRegistryState.data;
    const preferred = {
      vault: "simple_vault_v1",
      escrow: "escrow_refund_v1",
      issuer_l1_token: "oma_l1_issuer_token_v1",
      regulated_wrapped_asset: "regulated_wrapped_asset_token_v1",
      controller: "regulated_wrapped_asset_controller_v1"
    };
    const template = templateById(registry, preferred[type]);
    if (template) return template;

    const templates = registry && Array.isArray(registry.templates) ? registry.templates : [];
    return templates.find(function (candidate) {
      return candidate && candidate.contract_type === type;
    }) || null;
  }

  async function loadToccataSdk() {
    setText(UI.sdkStatus, "checking");
    try {
      const sdk = await window.kaspaToccataReady;
      const report = {
        ok: true,
        version: safeType(sdk.version) === "function" ? sdk.version() : "unknown",
        Transaction: safeType(sdk.Transaction),
        TransactionOutput: safeType(sdk.TransactionOutput),
        CovenantBinding: safeType(sdk.CovenantBinding),
        PaymentOutput: safeType(sdk.PaymentOutput),
        covenantId: safeType(sdk.covenantId),
        signing: "disabled",
        broadcasting: "disabled",
        minting: "disabled"
      };

      setText(UI.sdkStatus, "loaded");
      setText(UI.sdkVersion, report.version);
      setText(UI.surfaceOutput, report.TransactionOutput === "function" ? "available" : "missing");
      setText(UI.surfaceCovenantId, report.covenantId === "function" ? "available" : "missing");
      setText(UI.executionMode, "preview only");

      return report;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      setText(UI.sdkStatus, "error");
      setText(UI.sdkVersion, "unavailable");
      setText(UI.surfaceOutput, "unavailable");
      setText(UI.surfaceCovenantId, "unavailable");
      setText(UI.executionMode, "preview only");
      return {
        ok: false,
        error: msg,
        signing: "disabled",
        broadcasting: "disabled",
        minting: "disabled"
      };
    }
  }

  function contractProfile(type) {
    const template = templateForContractType(type);
    if (template) {
      return {
        label: template.template_name || template.template_id || type,
        classification_target: template.classification || template.contract_type || "unknown",
        required_proofs: asArray(template.required_proofs).length ? asArray(template.required_proofs) : asArray(template.allowed_actions),
        template_id: template.template_id || null,
        template_version: template.template_version || null,
        contract_type: template.contract_type || type,
        proof_status: template.proof_status || null,
        warning_class: template.warning_class || null,
        network_support: asArray(template.network_support),
        live_action_enabled: template.live_action_enabled === true,
        signing_enabled: template.signing_enabled === true,
        broadcasting_enabled: template.broadcasting_enabled === true,
        minting_enabled: template.minting_enabled === true
      };
    }

    const profiles = {
      vault: {
        label: "Vault / Recovery Policy",
        classification_target: "vault_kas",
        required_proofs: ["template_hash", "owner_path", "delay_or_recovery_policy", "normal_send_exclusion"]
      },
      escrow: {
        label: "Escrow / Refund Policy",
        classification_target: "escrow_kas",
        required_proofs: ["template_hash", "seller_path", "buyer_refund_path", "timeout_policy"]
      },
      issuer_l1_token: {
        label: "Issuer-Controlled L1 Token",
        classification_target: "l1_covenant_token",
        required_proofs: ["asset_covenant_id", "controller_covenant_id", "supply_invariant", "token_state_schema"]
      },
      regulated_wrapped_asset: {
        label: "Regulated Wrapped Asset",
        classification_target: "regulated_asset_token",
        required_proofs: ["controller_policy", "freeze_path", "seize_path", "burn_path", "audit_hash"]
      },
      controller: {
        label: "Controller / Minter Policy",
        classification_target: "controller_state",
        required_proofs: ["role_policy", "supply_policy", "mint_authority", "action_log"]
      }
    };
    return profiles[type] || profiles.vault;
  }

  function findPreviewBuilderArticle() {
    const articles = Array.from(document.querySelectorAll("article.card"));
    return articles.find(function (article) {
      return /Preview Builder/.test(String(article.textContent || ""));
    }) || null;
  }

  function findTemplateRegistryArticle() {
    const articles = Array.from(document.querySelectorAll("article.card"));
    return articles.find(function (article) {
      return /Template Registry/.test(String(article.textContent || ""));
    }) || null;
  }

  function fieldValue(id) {
    return readField($(id)) || null;
  }

  function profileSpecificFieldsHtml(type) {
    if (type === "issuer_l1_token") {
      return `
        <div class="cc-preview-box">
          <strong>OMA L1 Covenant Token Profile v0.1</strong><br>
          Token identity is the <code>asset_covenant_id</code>. Token balance comes from decoded <code>oma_l1_token_state_v1.amount_raw</code>, not from the carrier KAS amount. This is preview-only until deploy, issue/mint, transfer, and post-submit state-scan proofs pass.
        </div>
        <div class="two-col">
          <label>Token name<input id="ccTokenName" type="text" placeholder="e.g. OMA Test L1 Token"></label>
          <label>Token symbol<input id="ccTokenSymbol" type="text" class="mono" placeholder="e.g. TDPLUS"></label>
          <label>Decimals<input id="ccTokenDecimals" type="number" min="0" max="18" step="1" placeholder="0"></label>
          <label>Max supply<input id="ccTokenMaxSupply" type="text" class="mono" placeholder="finite cap"></label>
          <label>Initial issue amount<input id="ccTokenInitialIssue" type="text" class="mono" placeholder="preview amount"></label>
          <label>Issuer ID<input id="ccIssuerId" type="text" placeholder="issuer/entity identifier"></label>
          <label>Legal policy hash / URI<input id="ccLegalPolicyHash" type="text" class="mono" placeholder="terms hash or URI"></label>
          <label>Controller covenant ID<input id="ccControllerCovenantId" type="text" class="mono" placeholder="generated or selected controller covenant ID"></label>
          <label>Mint authority<input id="ccMintAuthority" type="text" class="mono" placeholder="pubkey, script hash, or role policy"></label>
          <label>Transfer rule
            <select id="ccTransferRule">
              <option value="owner_signed">owner signed</option>
              <option value="controller_approved">controller approved</option>
              <option value="allowlist_required">allowlist required</option>
            </select>
          </label>
          <label>Burn rule
            <select id="ccBurnRule">
              <option value="owner_or_issuer">owner or issuer</option>
              <option value="issuer_only">issuer only</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label>Redemption rule
            <select id="ccRedemptionRule">
              <option value="issuer_redemption">issuer redemption</option>
              <option value="burn_to_redeem">burn to redeem</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
        </div>
      `;
    }

    if (type === "regulated_wrapped_asset") {
      return `
        <div class="two-col">
          <label>Asset name<input id="ccRegAssetName" type="text" placeholder="e.g. Wrapped Energy Credit"></label>
          <label>Asset type
            <select id="ccRegAssetType">
              <option value="fiat">fiat</option>
              <option value="commodity">commodity</option>
              <option value="security">security</option>
              <option value="carbon">carbon</option>
              <option value="energy_credit">energy credit</option>
              <option value="receivable">receivable</option>
              <option value="real_world_asset">real-world asset</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <label>Symbol<input id="ccRegSymbol" type="text" class="mono" placeholder="display symbol"></label>
          <label>Decimals<input id="ccRegDecimals" type="number" min="0" max="18" step="1" placeholder="0"></label>
          <label>Reserve/custody statement hash<input id="ccReserveHash" type="text" class="mono" placeholder="reserve or custody hash"></label>
          <label>Jurisdiction<input id="ccJurisdiction" type="text" placeholder="e.g. US-NC"></label>
          <label>Legal terms hash<input id="ccRegLegalHash" type="text" class="mono" placeholder="legal terms hash"></label>
          <label>Issuer admin key<input id="ccIssuerAdmin" type="text" class="mono" placeholder="issuer admin pubkey or policy"></label>
          <label>Compliance admin key<input id="ccComplianceAdmin" type="text" class="mono" placeholder="compliance admin pubkey or policy"></label>
          <label>Freeze authority<input id="ccFreezeAuthority" type="text" class="mono" placeholder="freeze authority"></label>
          <label>Seize authority<input id="ccSeizeAuthority" type="text" class="mono" placeholder="seize authority"></label>
          <label>Burn/redeem authority<input id="ccBurnRedeemAuthority" type="text" class="mono" placeholder="burn or redemption authority"></label>
          <label>Emergency pause
            <select id="ccEmergencyPause">
              <option value="enabled">enabled in template preview</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label>Audit policy hash<input id="ccAuditPolicyHash" type="text" class="mono" placeholder="audit or action-log hash"></label>
        </div>
      `;
    }

    if (type === "controller") {
      return `
        <div class="two-col">
          <label>Controller covenant ID<input id="ccControllerPolicyId" type="text" class="mono" placeholder="controller covenant ID"></label>
          <label>Mint authority<input id="ccControllerMintAuthority" type="text" class="mono" placeholder="mint authority"></label>
          <label>Role policy<input id="ccControllerRolePolicy" type="text" class="mono" placeholder="m-of-n, admin key set, or policy hash"></label>
          <label>Max supply / allowance<input id="ccControllerMaxSupply" type="text" class="mono" placeholder="finite allowance"></label>
        </div>
      `;
    }

    return `
      <div class="two-col">
        <label>Recovery identifier<input id="ccRecoveryIdentifier" type="text" class="mono" placeholder="recovery pubkey, script hash, or controller ID"></label>
        <label>Allowed destination<input id="ccAllowedDestination" type="text" class="mono" placeholder="optional destination address or script hash"></label>
        <label>Timelock / DAA delay<input id="ccTimelockDaa" type="text" class="mono" placeholder="optional DAA/block delay"></label>
        <label>Policy note<input id="ccPolicyNote" type="text" placeholder="human-readable policy note"></label>
      </div>
    `;
  }

  function ensureProfileSpecificPanel() {
    const existing = $("ccProfileSpecificPanel");
    if (existing) {
      UI.profileSpecificPanel = existing;
      UI.profileSpecificFields = $("ccProfileSpecificFields");
      UI.profileSpecificSummary = $("ccProfileSpecificSummary");
      return existing;
    }

    const article = document.createElement("article");
    article.className = "card";
    article.id = "ccProfileSpecificPanel";
    article.innerHTML = `
      <header>
        <h3>Template-Specific Builder Inputs</h3>
        <p class="muted">Preview-only knobs and handles for the selected template. These fields feed the proof packet only; they do not sign, broadcast, mint, or mutate wallet state.</p>
      </header>
      <div id="ccProfileSpecificSummary" class="cc-warning">Select a contract type to load its preview fields.</div>
      <div id="ccProfileSpecificFields" class="stack" style="margin-top:1rem;"></div>
    `;

    const preview = findPreviewBuilderArticle();
    if (preview && preview.parentNode) {
      preview.parentNode.insertBefore(article, preview.nextSibling);
    } else {
      document.querySelector("main")?.appendChild(article);
    }

    UI.profileSpecificPanel = article;
    UI.profileSpecificFields = $("ccProfileSpecificFields");
    UI.profileSpecificSummary = $("ccProfileSpecificSummary");
    refreshProfileSpecificPanel();
    return article;
  }

  function refreshProfileSpecificPanel() {
    ensureProfileSpecificPanel();
    const type = readField(UI.contractType) || "vault";
    const profile = contractProfile(type);
    if (UI.profileSpecificSummary) {
      UI.profileSpecificSummary.innerHTML = `
        <strong>${escapeHtml(profile.label || type)}</strong><br>
        Profile fields are preview-only and are included in <code>profile_specific_inputs</code>. Live action remains disabled.
      `;
    }
    if (UI.profileSpecificFields) {
      UI.profileSpecificFields.innerHTML = profileSpecificFieldsHtml(type);
    }
  }

  function readProfileSpecificInputs(contractType) {
    const base = {
      profile_inputs_kind: "oma_covenant_controls_profile_inputs_v1",
      contract_type: contractType,
      application_status: "preview_only",
      signing_enabled: false,
      broadcasting_enabled: false,
      minting_enabled: false,
      live_action_enabled: false
    };

    if (contractType === "issuer_l1_token") {
      return Object.assign({}, base, {
        profile_kind: "oma_l1_issuer_token_profile_v0_1",
        standard_id: "oma_l1_covenant_token_profile_v0_1",
        token_state_schema: "oma_l1_token_state_v1",
        controller_state_schema: "oma_l1_token_controller_state_v1",
        canonical_token_id_source: "asset_covenant_id",
        carrier_kas_role: "utxo_value_fee_and_storage_carrier_not_token_amount",
        token_name: fieldValue("ccTokenName"),
        symbol: fieldValue("ccTokenSymbol"),
        decimals: fieldValue("ccTokenDecimals"),
        max_supply: fieldValue("ccTokenMaxSupply"),
        initial_issue_amount: fieldValue("ccTokenInitialIssue"),
        issuer_id: fieldValue("ccIssuerId"),
        legal_policy_hash_or_uri: fieldValue("ccLegalPolicyHash"),
        controller_covenant_id: fieldValue("ccControllerCovenantId"),
        mint_authority: fieldValue("ccMintAuthority"),
        transfer_rule: fieldValue("ccTransferRule"),
        burn_rule: fieldValue("ccBurnRule"),
        redemption_rule: fieldValue("ccRedemptionRule"),
        freeze_seize_requested: false
      });
    }

    if (contractType === "regulated_wrapped_asset") {
      return Object.assign({}, base, {
        profile_kind: "regulated_wrapped_asset_profile_v1",
        asset_name: fieldValue("ccRegAssetName"),
        asset_type: fieldValue("ccRegAssetType"),
        symbol: fieldValue("ccRegSymbol"),
        decimals: fieldValue("ccRegDecimals"),
        reserve_statement_hash: fieldValue("ccReserveHash"),
        jurisdiction: fieldValue("ccJurisdiction"),
        legal_terms_hash: fieldValue("ccRegLegalHash"),
        issuer_admin: fieldValue("ccIssuerAdmin"),
        compliance_admin: fieldValue("ccComplianceAdmin"),
        freeze_authority: fieldValue("ccFreezeAuthority"),
        seize_authority: fieldValue("ccSeizeAuthority"),
        burn_redeem_authority: fieldValue("ccBurnRedeemAuthority"),
        emergency_pause: fieldValue("ccEmergencyPause"),
        audit_policy_hash: fieldValue("ccAuditPolicyHash"),
        admin_actions_previewed: ["freeze", "seize", "burn", "redeem", "pause", "role_rotation"]
      });
    }

    if (contractType === "controller") {
      return Object.assign({}, base, {
        profile_kind: "controller_policy_profile_v1",
        controller_covenant_id: fieldValue("ccControllerPolicyId"),
        mint_authority: fieldValue("ccControllerMintAuthority"),
        role_policy: fieldValue("ccControllerRolePolicy"),
        max_supply_or_allowance: fieldValue("ccControllerMaxSupply")
      });
    }

    return Object.assign({}, base, {
      profile_kind: "basic_covenant_policy_profile_v1",
      recovery_identifier: fieldValue("ccRecoveryIdentifier"),
      allowed_destination: fieldValue("ccAllowedDestination"),
      timelock_daa: fieldValue("ccTimelockDaa"),
      policy_note: fieldValue("ccPolicyNote")
    });
  }


  function profileFieldMissing(inputs, fieldName) {
    const value = inputs ? inputs[fieldName] : null;
    return value === null || value === undefined || String(value).trim() === "";
  }

  function profileMissingFields(inputs, fields) {
    return asArray(fields).filter(function (fieldName) {
      return profileFieldMissing(inputs, fieldName);
    });
  }

  function validateProfileSpecificInputs(contractType, inputs) {
    const profileKind = inputs && inputs.profile_kind ? inputs.profile_kind : "unknown_profile";
    const warnings = [
      "profile_inputs_are_preview_only",
      "live_action_requires_template_specific_offline_builder_proof"
    ];
    const base = {
      validation_kind: "oma_covenant_controls_profile_validation_v1",
      contract_type: contractType,
      profile_kind: profileKind,
      application_status: "preview_only",
      signing_enabled: false,
      broadcasting_enabled: false,
      minting_enabled: false,
      live_action_ready: false,
      missing_required_fields: [],
      missing_recommended_fields: [],
      warnings,
      validation_blockers_before_live_action: [
        "offline_builder_not_proven",
        "local_mac_signing_broadcast_mint_proof_not_complete"
      ]
    };

    if (contractType === "issuer_l1_token") {
      const required = ["token_name", "symbol", "decimals", "max_supply", "issuer_id", "mint_authority"];
      const recommended = ["initial_issue_amount", "legal_policy_hash_or_uri", "controller_covenant_id"];
      const missingRequired = profileMissingFields(inputs, required);
      const missingRecommended = profileMissingFields(inputs, recommended);
      return Object.assign({}, base, {
        required_fields: required,
        recommended_fields: recommended,
        missing_required_fields: missingRequired,
        missing_recommended_fields: missingRecommended,
        validation_status: missingRequired.length ? "preview_inputs_incomplete" : "preview_inputs_captured",
        warnings: warnings.concat(missingRequired.length ? ["issuer_l1_token_required_fields_missing"] : []).concat(missingRecommended.length ? ["issuer_l1_token_recommended_fields_missing"] : [])
      });
    }

    if (contractType === "regulated_wrapped_asset") {
      const required = ["asset_name", "asset_type", "symbol", "reserve_statement_hash", "jurisdiction", "legal_terms_hash", "issuer_admin", "compliance_admin", "freeze_authority", "seize_authority", "burn_redeem_authority", "audit_policy_hash"];
      const missingRequired = profileMissingFields(inputs, required);
      return Object.assign({}, base, {
        required_fields: required,
        recommended_fields: ["decimals"],
        missing_required_fields: missingRequired,
        missing_recommended_fields: profileMissingFields(inputs, ["decimals"]),
        validation_status: missingRequired.length ? "preview_inputs_incomplete" : "preview_inputs_captured",
        warnings: warnings.concat(missingRequired.length ? ["regulated_wrapped_asset_required_fields_missing"] : [])
      });
    }

    if (contractType === "controller") {
      const required = ["controller_covenant_id", "mint_authority", "role_policy", "max_supply_or_allowance"];
      const missingRequired = profileMissingFields(inputs, required);
      return Object.assign({}, base, {
        required_fields: required,
        recommended_fields: [],
        missing_required_fields: missingRequired,
        validation_status: missingRequired.length ? "preview_inputs_incomplete" : "preview_inputs_captured",
        warnings: warnings.concat(missingRequired.length ? ["controller_policy_required_fields_missing"] : [])
      });
    }

    const policyFields = ["recovery_identifier", "allowed_destination", "timelock_daa"];
    const policyConstraintPresent = policyFields.some(function (fieldName) {
      return !profileFieldMissing(inputs, fieldName);
    });
    return Object.assign({}, base, {
      required_fields: ["one_of:recovery_identifier|allowed_destination|timelock_daa"],
      recommended_fields: ["policy_note"],
      policy_constraint_present: policyConstraintPresent,
      missing_required_fields: policyConstraintPresent ? [] : ["one_of:recovery_identifier|allowed_destination|timelock_daa"],
      missing_recommended_fields: profileMissingFields(inputs, ["policy_note"]),
      validation_status: policyConstraintPresent ? "preview_inputs_captured" : "preview_inputs_incomplete",
      warnings: warnings.concat(policyConstraintPresent ? [] : ["basic_covenant_policy_constraint_missing"])
    });
  }

  function utf8ToHex(value) {
    const bytes = new TextEncoder().encode(String(value == null ? "" : value));
    return Array.from(bytes).map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  function hexToUtf8(hex) {
    const clean = String(hex || "").trim();
    if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return "";
    const bytes = new Uint8Array(clean.match(/../g).map(function (pair) {
      return parseInt(pair, 16);
    }));
    return new TextDecoder().decode(bytes);
  }

  function compactString(value) {
    const text = String(value == null ? "" : value).trim();
    return text || null;
  }

  function compactTokenNumber(value, fallback) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return fallback;
    return text;
  }

  function omaL1StateEnvelopeFields(role, inputs) {
    const schema = role === "controller" ? "oma_l1_token_controller_state_v1" : "oma_l1_token_state_v1";
    const base = {
      magic: "OMA_L1_STATE",
      version: 1,
      standard_id: "oma_l1_covenant_token_profile_v0_1",
      schema,
      role,
      asset_covenant_id: "output.covenant.covenantId",
      token_symbol: compactString(inputs && inputs.symbol),
      decimals: compactTokenNumber(inputs && inputs.decimals, "0")
    };

    if (role === "controller") {
      return Object.assign({}, base, {
        issuer_id: compactString(inputs && inputs.issuer_id),
        mint_authority: compactString(inputs && inputs.mint_authority),
        max_supply_raw: compactTokenNumber(inputs && inputs.max_supply, "0"),
        issued_supply_raw: compactTokenNumber(inputs && inputs.initial_issue_amount, "0"),
        minting_enabled: true,
        burning_enabled: compactString(inputs && inputs.burn_rule) ? true : false,
        policy_hash_or_uri: compactString(inputs && inputs.legal_policy_hash_or_uri)
      });
    }

    return Object.assign({}, base, {
      owner_identifier_type: "issuer_or_mint_authority_preview",
      owner_identifier: compactString((inputs && inputs.issuer_id) || (inputs && inputs.mint_authority)),
      amount_raw: compactTokenNumber(inputs && inputs.initial_issue_amount, "0"),
      transfer_rule: compactString(inputs && inputs.transfer_rule) || "issuer_profile_transfer_rule_preview"
    });
  }

  async function buildOmaL1ScriptPublicKeyEnvelopeProof(role, inputs) {
    const envelope = omaL1StateEnvelopeFields(role, inputs);
    const canonicalJson = stableJson(envelope);
    const canonicalJsonSha256 = await sha256Text(canonicalJson);
    const envelopeHex = utf8ToHex(canonicalJson);
    const decodedJson = hexToUtf8(envelopeHex);
    let decoded = null;
    let decodeOk = false;
    try {
      decoded = JSON.parse(decodedJson);
      decodeOk = stableJson(decoded) === canonicalJson;
    } catch (_e) {
      decoded = null;
      decodeOk = false;
    }

    const proof = {
      envelope_kind: "oma_l1_token_state_envelope_v1",
      envelope_status: "offline_scriptpublickey_state_envelope_preview",
      role,
      state_schema: envelope.schema,
      canonical_json_sha256: canonicalJsonSha256,
      canonical_json_byte_len: new TextEncoder().encode(canonicalJson).length,
      envelope_hex_byte_len: envelopeHex.length / 2,
      decode_round_trip_ok: decodeOk,
      decoded_fields: decoded,
      script_public_key_preview: {
        status: "not_attempted",
        sdk_script_builder_used: false,
        covenants_enabled_flag: true,
        script_contains_state_envelope: false,
        script_hex_sha256: null,
        script_hex_byte_len: null,
        script_public_key_version: null,
        script_public_key_script_byte_len: null,
        warning: "script builder unavailable"
      },
      safety: {
        private_key_read: false,
        signing: "none",
        submit_called: false,
        broadcasting: "none",
        minting: "none",
        wallet_mutation: "none"
      }
    };

    try {
      const sdk = await window.kaspaToccataReady;
      if (!sdk || typeof sdk.ScriptBuilder !== "function" || typeof sdk.ScriptPublicKey !== "function") {
        proof.script_public_key_preview.status = "sdk_script_builder_missing";
        proof.script_public_key_preview.warning = "ScriptBuilder or ScriptPublicKey missing from SDK";
        return proof;
      }
      const builder = new sdk.ScriptBuilder({ flags: { covenantsEnabled: true } });
      const canonicalDataSize = typeof sdk.ScriptBuilder.canonicalDataSize === "function"
        ? sdk.ScriptBuilder.canonicalDataSize(envelopeHex)
        : null;
      builder.addData(envelopeHex);
      const scriptHex = builder.drain();
      const scriptHash = await sha256Text(scriptHex);
      const scriptPublicKey = new sdk.ScriptPublicKey(0, scriptHex);
      const scriptPublicKeyJson = typeof scriptPublicKey.toJSON === "function" ? scriptPublicKey.toJSON() : null;
      proof.script_public_key_preview = {
        status: scriptHex && scriptHex.includes(envelopeHex) ? "scriptpublickey_state_envelope_encoded" : "scriptpublickey_state_envelope_not_found",
        sdk_script_builder_used: true,
        covenants_enabled_flag: true,
        canonical_data_size: canonicalDataSize,
        script_contains_state_envelope: !!(scriptHex && scriptHex.includes(envelopeHex)),
        script_hex_sha256: scriptHash,
        script_hex_byte_len: scriptHex ? scriptHex.length / 2 : 0,
        script_public_key_version: scriptPublicKey.version,
        script_public_key_script_byte_len: scriptPublicKey.script ? String(scriptPublicKey.script).length / 2 : null,
        script_public_key_json: scriptPublicKeyJson,
        warning: "state envelope is encoded in a scriptPublicKey preview only; covenant transition enforcement script remains CC10C/CC10D work"
      };
      return proof;
    } catch (e) {
      proof.script_public_key_preview.status = "scriptpublickey_state_envelope_build_failed";
      proof.script_public_key_preview.warning = String(e && e.message ? e.message : e);
      return proof;
    }
  }

  async function buildOmaL1TokenStateEnvelopePreview(inputs) {
    const controller = await buildOmaL1ScriptPublicKeyEnvelopeProof("controller", inputs);
    const holder = await buildOmaL1ScriptPublicKeyEnvelopeProof("holder", inputs);
    return {
      proof_kind: "oma_l1_token_state_envelope_offline_proof_v1",
      proof_status: "offline_state_envelope_encoded_and_decoded",
      storage_location_decision: "scriptPublicKey_state_envelope_preview",
      asset_covenant_id_source: "output.covenant.covenantId",
      token_amount_source: "decoded oma_l1_token_state_v1.amount_raw, not carrier KAS amount",
      controller_state_envelope: controller,
      holder_token_state_envelope: holder,
      deploy_builder_gate: "CC10C deploy build-only may proceed only if both envelopes decode and scriptPublicKey previews contain the state envelope",
      both_envelopes_decode: controller.decode_round_trip_ok === true && holder.decode_round_trip_ok === true,
      both_script_previews_contain_envelope: controller.script_public_key_preview.script_contains_state_envelope === true && holder.script_public_key_preview.script_contains_state_envelope === true,
      safety: {
        signing: "none",
        submit_called: false,
        broadcasting: "none",
        minting: "none",
        aws: "not_touched"
      }
    };
  }

  async function buildProfileTransitionPreview(contractType, inputs, validation, selectedTemplate) {
    const base = {
      preview_kind: "oma_covenant_controls_profile_transition_preview_v1",
      transition_status: "preview_only_no_transaction_built",
      contract_type: contractType,
      profile_kind: inputs && inputs.profile_kind ? inputs.profile_kind : "unknown_profile",
      template_id: selectedTemplate && selectedTemplate.template_id ? selectedTemplate.template_id : null,
      template_version: selectedTemplate && selectedTemplate.template_version ? selectedTemplate.template_version : null,
      proof_status: selectedTemplate && selectedTemplate.proof_status ? selectedTemplate.proof_status : null,
      application_status: "preview_only",
      signing_enabled: false,
      broadcasting_enabled: false,
      minting_enabled: false,
      live_action_enabled: false,
      validation_status: validation && validation.validation_status ? validation.validation_status : "unknown",
      normal_send_exclusion_required: true,
      post_submit_scan_required: true,
      compute_storage_fee_status: "not_estimated_until_template_specific_offline_builder",
      transaction_build_status: "not_built_yet",
      input_plan_preview: [],
      output_plan_preview: [],
      state_transition_preview: {},
      role_requirements_preview: [],
      admin_actions_preview: [],
      warnings: [
        "preview_only_no_transaction_built",
        "offline_builder_required_before_signing",
        "local_mac_signing_broadcast_mint_proof_required_before_live_action"
      ]
    };

    if (contractType === "issuer_l1_token") {
      return Object.assign({}, base, {
        input_plan_preview: [
          { role: "funding_input", source: "native_kas_utxo", covenant_bearing_allowed: false },
          { role: "issuer_authority", source: inputs && inputs.mint_authority ? "mint_authority_input" : "missing_mint_authority" }
        ],
        output_plan_preview: [
          { output_role: "asset_covenant_genesis", covenant_id: "to_be_computed_by_offline_builder", canonical_token_id: "asset_covenant_id", token_symbol: inputs && inputs.symbol, max_supply: inputs && inputs.max_supply },
          { output_role: "controller_state", state_schema: "oma_l1_token_controller_state_v1", controller_covenant_id: inputs && inputs.controller_covenant_id, issued_supply_raw: inputs && inputs.initial_issue_amount ? inputs.initial_issue_amount : "0" },
          { output_role: "holder_token_state", state_schema: "oma_l1_token_state_v1", amount_raw: inputs && inputs.initial_issue_amount, status: inputs && inputs.initial_issue_amount ? "previewed" : "optional_or_missing" },
          { output_role: "change_output", covenant_bearing: false }
        ],
        token_standard_preview: {
          standard_id: "oma_l1_covenant_token_profile_v0_1",
          canonical_token_id_source: "asset_covenant_id",
          token_state_schema: "oma_l1_token_state_v1",
          controller_state_schema: "oma_l1_token_controller_state_v1",
          token_amount_source: "token_state.amount_raw_not_carrier_kas",
          product_ready_after: ["deploy_genesis", "issue_mint", "transfer", "normal_send_exclusion", "post_submit_state_scan"]
        },
        token_state_envelope_preview: await buildOmaL1TokenStateEnvelopePreview(inputs),
        required_live_proof_sequence: [
          "CC10C deploy build-only",
          "CC10D deploy sign-only",
          "CC10E deploy submit",
          "CC10F issue/mint build-only",
          "CC10G issue/mint sign-only",
          "CC10H issue/mint submit",
          "CC10I transfer proof"
        ],
        state_transition_preview: {
          token_name: inputs && inputs.token_name,
          symbol: inputs && inputs.symbol,
          decimals: inputs && inputs.decimals,
          max_supply: inputs && inputs.max_supply,
          initial_issue_amount: inputs && inputs.initial_issue_amount,
          transfer_rule: inputs && inputs.transfer_rule,
          burn_rule: inputs && inputs.burn_rule,
          redemption_rule: inputs && inputs.redemption_rule,
          supply_delta_preview: inputs && inputs.initial_issue_amount ? `+${inputs.initial_issue_amount}` : "0_or_not_set"
        },
        role_requirements_preview: [
          { role: "issuer_id", value: inputs && inputs.issuer_id },
          { role: "mint_authority", value: inputs && inputs.mint_authority },
          { role: "controller_covenant_id", value: inputs && inputs.controller_covenant_id }
        ]
      });
    }

    if (contractType === "regulated_wrapped_asset") {
      return Object.assign({}, base, {
        input_plan_preview: [
          { role: "funding_input", source: "native_kas_utxo", covenant_bearing_allowed: false },
          { role: "issuer_admin_authorization", source: inputs && inputs.issuer_admin ? "issuer_admin" : "missing_issuer_admin" },
          { role: "compliance_admin_authorization", source: inputs && inputs.compliance_admin ? "compliance_admin" : "missing_compliance_admin" }
        ],
        output_plan_preview: [
          { output_role: "regulated_asset_controller_state", asset_type: inputs && inputs.asset_type, emergency_pause: inputs && inputs.emergency_pause },
          { output_role: "regulated_asset_token_state", symbol: inputs && inputs.symbol, freeze_seize_burn_paths: "declared_in_profile" },
          { output_role: "audit_action_state", audit_policy_hash: inputs && inputs.audit_policy_hash },
          { output_role: "change_output", covenant_bearing: false }
        ],
        state_transition_preview: {
          asset_name: inputs && inputs.asset_name,
          asset_type: inputs && inputs.asset_type,
          symbol: inputs && inputs.symbol,
          reserve_statement_hash: inputs && inputs.reserve_statement_hash,
          jurisdiction: inputs && inputs.jurisdiction,
          legal_terms_hash: inputs && inputs.legal_terms_hash,
          emergency_pause: inputs && inputs.emergency_pause
        },
        role_requirements_preview: [
          { role: "issuer_admin", value: inputs && inputs.issuer_admin },
          { role: "compliance_admin", value: inputs && inputs.compliance_admin },
          { role: "freeze_authority", value: inputs && inputs.freeze_authority },
          { role: "seize_authority", value: inputs && inputs.seize_authority },
          { role: "burn_redeem_authority", value: inputs && inputs.burn_redeem_authority }
        ],
        admin_actions_preview: asArray(inputs && inputs.admin_actions_previewed).map(function (action) {
          return { action, status: "declared_preview_only", audit_required: true };
        })
      });
    }

    if (contractType === "controller") {
      return Object.assign({}, base, {
        input_plan_preview: [
          { role: "funding_input", source: "native_kas_utxo", covenant_bearing_allowed: false },
          { role: "controller_authority", source: inputs && inputs.mint_authority ? "mint_authority" : "missing_mint_authority" }
        ],
        output_plan_preview: [
          { output_role: "controller_covenant_state", controller_covenant_id: inputs && inputs.controller_covenant_id },
          { output_role: "allowance_or_supply_policy_state", max_supply_or_allowance: inputs && inputs.max_supply_or_allowance },
          { output_role: "role_policy_state", role_policy: inputs && inputs.role_policy },
          { output_role: "change_output", covenant_bearing: false }
        ],
        state_transition_preview: {
          controller_covenant_id: inputs && inputs.controller_covenant_id,
          max_supply_or_allowance: inputs && inputs.max_supply_or_allowance,
          role_policy: inputs && inputs.role_policy
        },
        role_requirements_preview: [
          { role: "mint_authority", value: inputs && inputs.mint_authority },
          { role: "role_policy", value: inputs && inputs.role_policy }
        ]
      });
    }

    return Object.assign({}, base, {
      input_plan_preview: [
        { role: "funding_input", source: "native_kas_utxo", covenant_bearing_allowed: false },
        { role: "owner_authorization", source: "owner_identifier_or_active_wallet" }
      ],
      output_plan_preview: [
        { output_role: "policy_covenant_output", recovery_identifier: inputs && inputs.recovery_identifier, allowed_destination: inputs && inputs.allowed_destination, timelock_daa: inputs && inputs.timelock_daa },
        { output_role: "change_output", covenant_bearing: false }
      ],
      state_transition_preview: {
        recovery_identifier: inputs && inputs.recovery_identifier,
        allowed_destination: inputs && inputs.allowed_destination,
        timelock_daa: inputs && inputs.timelock_daa,
        policy_note: inputs && inputs.policy_note
      },
      role_requirements_preview: [
        { role: "owner", value: "active_wallet_or_supplied_owner_identifier" },
        { role: "recovery", value: inputs && inputs.recovery_identifier },
        { role: "destination_constraint", value: inputs && inputs.allowed_destination },
        { role: "timelock_constraint", value: inputs && inputs.timelock_daa }
      ]
    });
  }

  function ensureTemplateRegistryPanel() {
    const existing = $("ccTemplateRegistryPanel");
    if (existing) {
      UI.registryRefresh = $("ccRegistryRefresh");
      UI.registryStatus = $("ccRegistryStatus");
      UI.registrySummary = $("ccRegistrySummary");
      UI.registryRows = $("ccRegistryRows");
      UI.registryJson = $("ccRegistryJson");
      return existing;
    }

    const article = findTemplateRegistryArticle() || document.createElement("article");
    article.className = "card";
    article.id = "ccTemplateRegistryPanel";
    article.innerHTML = `
      <header>
        <h3>Template Registry</h3>
        <p class="muted">Loaded from <code>${escapeHtml(TEMPLATE_REGISTRY_URL)}</code>. Mainnet templates may be listed, but live actions stay disabled until Mac proof and explicit approval.</p>
      </header>

      <details id="ccTemplateRegistryDetails" class="cc-large-panel-collapse">
        <summary>
          <span class="cc-large-panel-summary">
            <span>Template Registry / Proof Library</span>
            <small>Collapsed by default. Open when you need template hashes, proof status, and raw registry JSON.</small>
          </span>
        </summary>
        <div class="cc-large-panel-body">
          <div class="two-col">
            <section class="stack">
              <button id="ccRegistryRefresh" type="button" class="secondary">Refresh template registry</button>
              <p class="muted">Status: <strong id="ccRegistryStatus">not loaded</strong></p>
              <div id="ccRegistrySummary" class="cc-preview-box">Waiting for template registry.</div>
            </section>
            <section class="stack">
              <div class="cc-preview-box">
                <strong>Registry safety lock</strong><br>
                Mainnet is supported by metadata, not by live action.<br>
                Signing disabled · Broadcasting disabled · Minting disabled
              </div>
            </section>
          </div>

          <div style="overflow:auto;margin-top:1rem;">
            <table role="grid">
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Type</th>
                  <th>Networks</th>
                  <th>Proof status</th>
                  <th>Live action</th>
                </tr>
              </thead>
              <tbody id="ccRegistryRows">
                <tr><td colspan="5">No registry loaded yet.</td></tr>
              </tbody>
            </table>
          </div>

          <details style="margin-top:1rem;">
            <summary>Template registry JSON</summary>
            <pre id="ccRegistryJson">{}</pre>
          </details>
        </div>
      </details>
    `;

    if (!article.parentNode) {
      document.querySelector("main")?.appendChild(article);
    }

    UI.registryRefresh = $("ccRegistryRefresh");
    UI.registryStatus = $("ccRegistryStatus");
    UI.registrySummary = $("ccRegistrySummary");
    UI.registryRows = $("ccRegistryRows");
    UI.registryJson = $("ccRegistryJson");
    return article;
  }

  function registrySummaryHtml(registry) {
    const policy = registry && registry.network_policy ? registry.network_policy : {};
    const safety = registry && registry.safety_state ? registry.safety_state : {};
    const templates = asArray(registry && registry.templates);
    return `
      <strong>${escapeHtml(registry.registry_kind || "registry")}</strong><br>
      Version: ${escapeHtml(registry.registry_version || "unknown")} · Status: ${escapeHtml(registry.registry_status || "unknown")}<br>
      Networks: ${escapeHtml(networkList(policy.registry_network_support))} · not TN10 gated: ${escapeHtml(boolLabel(policy.not_tn10_gated))}<br>
      Templates: ${escapeHtml(templates.length)} · signing=${escapeHtml(boolLabel(safety.signing_enabled))} · broadcasting=${escapeHtml(boolLabel(safety.broadcasting_enabled))} · minting=${escapeHtml(boolLabel(safety.minting_enabled))}
    `;
  }

  function registryRowHtml(template) {
    const liveAction = template.live_action_enabled === true ? "enabled" : "disabled";
    const warning = template.warning ? `<br><small>${escapeHtml(template.warning)}</small>` : "";
    return `
      <tr>
        <td><strong>${escapeHtml(template.template_name || template.template_id || "template")}</strong><br><code>${escapeHtml(template.template_id || "")}</code>${warning}</td>
        <td>${escapeHtml(template.contract_type || "unknown")}<br><small>token=${escapeHtml(boolLabel(template.token))} · normal-send=${escapeHtml(template.normal_send_eligible ? "eligible" : "blocked")}</small></td>
        <td>${escapeHtml(networkList(template.network_support))}</td>
        <td>${escapeHtml(template.proof_status || "unknown")}</td>
        <td>${escapeHtml(liveAction)}</td>
      </tr>
    `;
  }

  function renderTemplateRegistry(registry, httpStatus) {
    ensureTemplateRegistryPanel();

    if (!registry || registry.registry_kind !== "oma_covenant_template_registry_v1") {
      const reason = registry && registry.reason ? registry.reason : "template_registry_unavailable";
      const errorJson = {
        ok: false,
        http_status: httpStatus,
        reason,
        response: registry || null,
        signing_enabled: false,
        broadcasting_enabled: false,
        minting_enabled: false
      };
      setText(UI.registryStatus, `blocked: ${reason}`);
      if (UI.registrySummary) {
        UI.registrySummary.innerHTML = `Template registry blocked: <strong>${escapeHtml(reason)}</strong>`;
      }
      if (UI.registryRows) {
        UI.registryRows.innerHTML = `<tr><td colspan="5">${escapeHtml(reason)}</td></tr>`;
      }
      setText(UI.registryJson, JSON.stringify(errorJson, null, 2));
      return;
    }

    const templates = asArray(registry.templates);
    setText(UI.registryStatus, `loaded: ${templates.length} templates`);
    if (UI.registrySummary) UI.registrySummary.innerHTML = registrySummaryHtml(registry);
    if (UI.registryRows) {
      UI.registryRows.innerHTML = templates.length
        ? templates.map(registryRowHtml).join("")
        : `<tr><td colspan="5">Registry contains no templates.</td></tr>`;
    }
    setText(UI.registryJson, JSON.stringify({
      registry_kind: registry.registry_kind,
      registry_version: registry.registry_version,
      registry_status: registry.registry_status,
      application_status: registry.application_status,
      network_policy: registry.network_policy,
      safety_state: registry.safety_state,
      classification_policy: registry.classification_policy,
      proof_requirements_before_live_actions: registry.proof_requirements_before_live_actions,
      templates
    }, null, 2));
  }

  async function loadTemplateRegistry() {
    ensureTemplateRegistryPanel();
    setText(UI.registryStatus, "loading");
    try {
      const response = await fetch(TEMPLATE_REGISTRY_URL, {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      const data = await response.json().catch(function () {
        return { reason: "invalid_json_response" };
      });
      if (!response.ok) {
        renderTemplateRegistry({ reason: `http_${response.status}`, response: data }, response.status);
        templateRegistryState.loaded = false;
        templateRegistryState.data = null;
        templateRegistryState.error = `http_${response.status}`;
        return null;
      }
      if (!data || data.registry_kind !== "oma_covenant_template_registry_v1") {
        renderTemplateRegistry({ reason: "unexpected_registry_kind", response: data }, response.status);
        templateRegistryState.loaded = false;
        templateRegistryState.data = null;
        templateRegistryState.error = "unexpected_registry_kind";
        return null;
      }
      templateRegistryState.loaded = true;
      templateRegistryState.data = data;
      templateRegistryState.error = null;
      renderTemplateRegistry(data, response.status);
      return data;
    } catch (e) {
      const reason = String(e && e.message ? e.message : e);
      renderTemplateRegistry({ reason }, 0);
      templateRegistryState.loaded = false;
      templateRegistryState.data = null;
      templateRegistryState.error = reason;
      return null;
    }
  }

  function ensureInspectionPolishStyles() {
    if (document.getElementById("ccInspectionPolishStyles")) return;
    const style = document.createElement("style");
    style.id = "ccInspectionPolishStyles";
    style.textContent = `
      #ccInspectionPanel table[role="grid"] th,
      #ccInspectionPanel table[role="grid"] td {
        background: rgba(var(--td-skin-table-bg-rgb), .62);
        color: var(--td-skin-text-strong);
        border-color: rgba(var(--td-skin-border-rgb), .28);
        vertical-align: top;
      }
      #ccInspectionPanel table[role="grid"] tbody tr:nth-child(even) td {
        background: rgba(var(--td-skin-table-bg-rgb), .44);
      }
      #ccInspectionPanel table[role="grid"] tbody tr.cc-inspect-verified-row td {
        background: rgba(var(--td-skin-table-bg-rgb), .76);
      }
      #ccInspectionPanel .cc-inspect-pagination {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: .65rem;
        flex-wrap: wrap;
        margin-top: .75rem;
      }
      #ccInspectionPanel .cc-inspect-pagination button {
        width: auto;
        min-width: 7.5rem;
        margin: 0;
      }
      #ccInspectionPanel .cc-inspect-pagination button[disabled] {
        opacity: .45;
        cursor: not-allowed;
      }
      #ccInspectionPanel .cc-inspect-page-info {
        color: var(--td-skin-text-soft);
        font-size: .85rem;
        font-weight: 700;
        letter-spacing: .02em;
      }
      #ccInspectionPanel .cc-inspect-sort-control {
        align-items: center;
        color: var(--td-skin-text-soft);
        display: inline-flex;
        font-size: .85rem;
        font-weight: 700;
        gap: .4rem;
        margin: 0;
      }
      #ccInspectionPanel .cc-inspect-sort-control select {
        height: 2.4rem;
        margin: 0;
        min-width: 14rem;
        padding: .25rem .75rem;
      }
      #ccInspectionPanel .cc-inspect-mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: var(--td-skin-text-strong);
        background: transparent;
        border: 0;
        padding: 0;
        white-space: nowrap;
      }
      #ccInspectionPanel .cc-inspect-link-button {
        appearance: none;
        -webkit-appearance: none;
        border: 0;
        background: transparent;
        color: var(--td-skin-cyan, #5ef0ff);
        cursor: pointer;
        display: inline;
        font: inherit;
        padding: 0;
        text-align: left;
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: .18em;
      }
      #ccInspectionPanel .cc-inspect-link-button:hover,
      #ccInspectionPanel .cc-inspect-link-button:focus-visible {
        color: var(--td-skin-text-strong);
        outline: none;
        text-decoration-thickness: 2px;
      }
      #ccInspectionPanel .cc-inspect-row-help {
        display: block;
        color: var(--td-skin-text-soft);
        font-size: .78rem;
        line-height: 1.35;
        margin-top: .18rem;
        max-width: 22rem;
      }
      #ccInspectionPanel code {
        background: rgba(var(--td-skin-table-bg-rgb), .62) !important;
        color: var(--td-skin-text-strong) !important;
        border: 1px solid rgba(var(--td-skin-border-rgb), .26) !important;
        border-radius: 6px !important;
        padding: .05rem .32rem !important;
      }
      #ccInspectionPanel .cc-inspect-muted {
        color: var(--td-skin-text-soft);
        opacity: .92;
      }
      #ccInspectionPanel .cc-inspect-detail-row td {
        background: rgba(var(--td-skin-table-bg-rgb), .52);
        border-top: 0;
        padding-top: .35rem;
      }
      #ccInspectionPanel .cc-inspect-detail-row details {
        border: 1px solid rgba(var(--td-skin-border-rgb), .26);
        border-radius: 10px;
        padding: .45rem .65rem;
        background: rgba(var(--td-skin-panel-rgb), .34);
      }
      #ccInspectionPanel .cc-inspect-detail-row summary {
        cursor: pointer;
        color: var(--td-skin-text-strong);
        font-weight: 700;
      }
      #ccInspectionPanel .cc-inspect-detail-row details > summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: .75rem;
      }
      #ccInspectionPanel .cc-inspect-detail-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: .35rem .85rem;
        margin-top: .5rem;
      }
      @media (max-width: 760px) {
        #ccInspectionPanel .cc-inspect-detail-grid { grid-template-columns: 1fr; }
      }
      #ccInspectionPanel .cc-inspect-kv {
        border-bottom: 1px solid rgba(var(--td-skin-border-rgb), .16);
        padding-bottom: .22rem;
        overflow-wrap: anywhere;
      }
      #ccInspectionPanel .cc-inspect-kv span {
        color: var(--td-skin-text-soft);
        display: block;
        font-size: .78rem;
        margin-bottom: .05rem;
      }
      #ccInspectionPanel .cc-inspect-kv strong {
        color: var(--td-skin-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: .85rem;
        font-weight: 650;
      }
      #ccInspectionPanel .cc-inspect-release-fields {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: .65rem;
        align-items: stretch;
      }
      @media (max-width: 760px) {
        #ccInspectionPanel .cc-inspect-release-fields { grid-template-columns: 1fr; }
      }
      #ccInspectionPanel .cc-inspect-copy-field {
        border: 1px solid rgba(var(--td-skin-border-rgb), .24);
        border-radius: 10px;
        background: rgba(var(--td-skin-panel-rgb), .26);
        padding: .55rem .65rem;
        overflow-wrap: anywhere;
      }
      #ccInspectionPanel .cc-inspect-copy-label {
        display: block;
        color: var(--td-skin-text-soft);
        font-weight: 800;
        font-size: .78rem;
        letter-spacing: .015em;
        margin-bottom: .25rem;
      }
      #ccInspectionPanel .cc-inspect-copy-value {
        display: block;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: var(--td-skin-text-strong);
        font-size: .82rem;
        line-height: 1.35;
        margin-bottom: .45rem;
      }
      #ccInspectionPanel .cc-inspect-copy-button {
        width: auto;
        min-width: 8.5rem;
        min-height: 2rem;
        padding: .35rem .75rem;
        border-radius: 999px;
        font-size: .72rem;
        line-height: 1;
      }
      #ccInspectionPanel .cc-inspect-compact-action-row td {
        background: rgba(var(--td-skin-table-bg-rgb), .42);
        padding-top: .2rem;
      }
      #ccInspectionPanel .cc-inspect-compact-action {
        border: 1px solid rgba(var(--td-skin-border-rgb), .22);
        border-radius: 10px;
        background: rgba(var(--td-skin-panel-rgb), .22);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: .75rem;
        padding: .5rem .65rem;
      }
      #ccInspectionPanel .cc-inspect-compact-action small {
        color: var(--td-skin-text-soft);
        display: block;
        font-weight: 500;
        margin-top: .12rem;
      }
      #ccInspectionPanel .cc-inspect-compact-action .cc-inspect-copy-button {
        min-width: auto;
        white-space: nowrap;
      }
      #ccInspectionPanel .cc-inspect-copy-status {
        display: inline-block;
        margin-left: .45rem;
        color: var(--td-skin-text-soft);
        font-size: .78rem;
      }
      #ccInspectionPanel .cc-inspect-metadata-card {
        border: 1px solid rgba(var(--td-skin-border-rgb), .28);
        border-radius: 12px;
        padding: .7rem .8rem;
        background: rgba(var(--td-skin-panel-rgb), .32);
        overflow-wrap: anywhere;
      }
      #ccInspectionPanel .cc-inspect-metadata-card[open] {
        background: rgba(var(--td-skin-panel-rgb), .42);
      }
      #ccInspectionPanel .cc-inspect-metadata-card > summary {
        cursor: pointer;
        color: var(--td-skin-text-strong);
        font-weight: 800;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: .75rem;
      }
      #ccInspectionPanel .cc-inspect-metadata-title {
        display: block;
        margin-bottom: .2rem;
      }
      #ccInspectionPanel .cc-inspect-metadata-summary {
        color: var(--td-skin-text-soft);
        display: block;
        font-size: .84rem;
        font-weight: 500;
        line-height: 1.35;
        margin-top: .18rem;
      }
      #ccInspectionPanel .cc-inspect-metadata-warning {
        border-left: 3px solid rgba(255, 205, 94, .74);
        color: var(--td-skin-text-strong);
        margin: .65rem 0 .25rem;
        padding: .35rem .55rem;
        background: rgba(255, 205, 94, .10);
        border-radius: 8px;
      }
      #ccInspectionPanel .cc-inspect-metadata-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: .4rem .85rem;
        margin-top: .65rem;
      }
      @media (max-width: 760px) {
        #ccInspectionPanel .cc-inspect-metadata-grid { grid-template-columns: 1fr; }
      }
      #ccInspectionPanel .cc-inspect-metadata-field {
        border-bottom: 1px solid rgba(var(--td-skin-border-rgb), .16);
        padding-bottom: .28rem;
      }
      #ccInspectionPanel .cc-inspect-metadata-field span {
        color: var(--td-skin-text-soft);
        display: block;
        font-size: .76rem;
        margin-bottom: .06rem;
      }
      #ccInspectionPanel .cc-inspect-metadata-field strong {
        color: var(--td-skin-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: .82rem;
        font-weight: 650;
        line-height: 1.35;
      }
      #ccInspectionPanel details.cc-large-panel-collapse,
      #ccTemplateRegistryPanel details.cc-large-panel-collapse {
        border: 1px solid rgba(94, 240, 255, 0.34);
        border-radius: 14px;
        background: rgba(4, 14, 31, 0.34);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.035);
      }
      #ccInspectionPanel details.cc-large-panel-collapse > summary,
      #ccTemplateRegistryPanel details.cc-large-panel-collapse > summary {
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: .85rem 1rem;
        color: var(--td-skin-white, #f6fbff);
        font-weight: 800;
        letter-spacing: .02em;
      }
      #ccInspectionPanel .cc-large-panel-summary,
      #ccTemplateRegistryPanel .cc-large-panel-summary {
        display: flex;
        flex-direction: column;
        gap: .18rem;
      }
      #ccInspectionPanel .cc-large-panel-summary small,
      #ccTemplateRegistryPanel .cc-large-panel-summary small {
        font-weight: 500;
        color: var(--td-skin-muted, rgba(255,255,255,.72));
        letter-spacing: 0;
      }
      #ccInspectionPanel .cc-large-panel-body,
      #ccTemplateRegistryPanel .cc-large-panel-body {
        border-top: 1px solid rgba(94, 240, 255, 0.18);
        padding: 1rem;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureInspectionPanel() {
    ensureInspectionPolishStyles();
    const existing = $("ccInspectionPanel");
    if (existing) {
      UI.inspectRefresh = $("ccInspectRefresh");
      UI.inspectStatus = $("ccInspectStatus");
      UI.inspectSummary = $("ccInspectSummary");
      UI.inspectRows = $("ccInspectRows");
      UI.inspectJson = $("ccInspectJson");
      UI.inspectPrev = $("ccInspectPrev");
      UI.inspectNext = $("ccInspectNext");
      UI.inspectPageInfo = $("ccInspectPageInfo");
      UI.inspectSort = $("ccInspectSort");
      return existing;
    }

    const article = document.createElement("article");
    article.className = "card";
    article.id = "ccInspectionPanel";
    article.innerHTML = `
      <header>
        <h3>Inspect Covenant UTXOs</h3>
        <p class="muted">Read-only active-wallet scan. Unknown covenants are never treated as tokens and are blocked from normal-send eligibility.</p>
      </header>

      <details id="ccInspectionDetails" class="cc-large-panel-collapse">
        <summary>
          <span class="cc-large-panel-summary">
            <span>Inspect Covenant UTXOs</span>
            <small>Collapsed by default. Open when you need row-level covenant classification and raw inspection JSON.</small>
          </span>
        </summary>
        <div class="cc-large-panel-body">
          <div class="two-col">
            <section class="stack">
              <button id="ccInspectRefresh" type="button">Refresh covenant inspection</button>
              <p class="muted">Status: <strong id="ccInspectStatus">not loaded</strong></p>
              <div id="ccInspectSummary" class="cc-preview-box">Waiting for read-only inspection.</div>
            </section>
            <section class="stack">
              <div class="cc-preview-box">
                <strong>Safety lock</strong><br>
                Signing disabled · Broadcasting disabled · Minting disabled<br>
                Classification path: <code>reference.entry.covenantId</code>
              </div>
            </section>
          </div>

          <div style="overflow:auto;margin-top:1rem;">
            <table role="grid">
              <thead>
                <tr>
                  <th>UTXO</th>
                  <th>Amount</th>
                  <th>Classification</th>
                  <th>Covenant ID</th>
                  <th>Normal send</th>
                </tr>
              </thead>
              <tbody id="ccInspectRows">
                <tr><td colspan="5">No inspection loaded yet.</td></tr>
              </tbody>
            </table>
          </div>

          <nav class="cc-inspect-pagination" aria-label="Covenant UTXO inspection pagination">
            <button id="ccInspectPrev" type="button" disabled>&lt; Back</button>
            <span id="ccInspectPageInfo" class="cc-inspect-page-info">Showing 0 rows</span>
            <label class="cc-inspect-sort-control" for="ccInspectSort">Sort
              <select id="ccInspectSort" autocomplete="off">
                <option value="amount_desc_outpoint">Amount high to low</option>
                <option value="amount_asc_outpoint">Amount low to high</option>
                <option value="utxo_asc">UTXO</option>
              </select>
            </label>
            <button id="ccInspectNext" type="button" disabled>Next &gt;</button>
          </nav>

          <details style="margin-top:1rem;">
            <summary>Read-only inspection JSON</summary>
            <pre id="ccInspectJson">{}</pre>
          </details>
        </div>
      </details>
    `;

    const mount = $("ccInspectionMount");
    if (mount && mount.parentNode) {
      mount.parentNode.replaceChild(article, mount);
    } else {
      const registry = findTemplateRegistryArticle();
      if (registry && registry.parentNode) {
        registry.parentNode.insertBefore(article, registry);
      } else {
        document.querySelector("main")?.appendChild(article);
      }
    }

    UI.inspectRefresh = $("ccInspectRefresh");
    UI.inspectStatus = $("ccInspectStatus");
    UI.inspectSummary = $("ccInspectSummary");
    UI.inspectRows = $("ccInspectRows");
    UI.inspectJson = $("ccInspectJson");
    UI.inspectPrev = $("ccInspectPrev");
    UI.inspectNext = $("ccInspectNext");
    UI.inspectPageInfo = $("ccInspectPageInfo");
    UI.inspectSort = $("ccInspectSort");
    if (UI.inspectSort) UI.inspectSort.value = inspectionPaginationState.sortMode;
    return article;
  }

  function inspectionSummaryHtml(data) {
    const counts = data && data.counts ? data.counts : {};
    const node = data && data.node ? data.node : {};
    const reconciliation = data && data.verified_oma_l1_reconciliation ? data.verified_oma_l1_reconciliation : null;
    const holderDisplay = reconciliation && reconciliation.holder_display ? reconciliation.holder_display : null;
    const verifiedLine = reconciliation ? `
      <br>Verified OMA L1 proof packet: ${escapeHtml(reconciliation.verified_rows || 0)}/2 matched${holderDisplay ? ` · ${escapeHtml(holderDisplay.amount_human)} ${escapeHtml(holderDisplay.token_symbol)} (raw ${escapeHtml(holderDisplay.amount_raw)}, decimals ${escapeHtml(holderDisplay.decimals)})` : ""}` : "";
    const safety = [
      `signing=${data && data.signing_enabled === false ? "disabled" : "unknown"}`,
      `broadcasting=${data && data.broadcasting_enabled === false ? "disabled" : "unknown"}`,
      `minting=${data && data.minting_enabled === false ? "disabled" : "unknown"}`
    ].join(" · ");

    return `
      <strong>${escapeHtml(data.inspection_kind || "inspection")}</strong><br>
      Wallet: <code>${escapeHtml(data.wallet_id || "")}</code><br>
      Address: <code>${escapeHtml(data.address || "")}</code><br>
      Network: ${escapeHtml(data.networkId || data.network || "unknown")} · SDK ${escapeHtml(data.sdk_version || "unknown")} · Node ${escapeHtml(node.serverVersion || "unknown")}<br>
      Registry: ${escapeHtml(data.template_registry && data.template_registry.registry_kind ? data.template_registry.registry_kind : "browser registry")} ${escapeHtml(data.template_registry && data.template_registry.registry_hash_sha256 ? shortText(data.template_registry.registry_hash_sha256, 12, 8) : "")}<br>
      Counts: ${escapeHtml(counts.total || 0)} active-wallet total · ${escapeHtml(counts.native_kas || 0)} native KAS · ${escapeHtml(counts.covenanted_kas || 0)} covenanted KAS · ${escapeHtml(counts.normal_send_blocked || 0)} blocked${verifiedLine}<br>
      ${escapeHtml(safety)}
    `;
  }

  function inspectionSortModeLabel(sortMode) {
    if (sortMode === "amount_asc_outpoint") return "amount low to high";
    if (sortMode === "utxo_asc") return "UTXO";
    return "amount high to low";
  }

  function renderInspectionPaginationControls(data) {
    const pagination = data && data.pagination && data.pagination.pagination_kind === "covenant_utxo_inspection_pagination_v1" ? data.pagination : null;
    inspectionPaginationState.last = pagination;

    if (!pagination || pagination.enabled !== true) {
      if (UI.inspectPrev) UI.inspectPrev.disabled = true;
      if (UI.inspectNext) UI.inspectNext.disabled = true;
      if (UI.inspectPageInfo) UI.inspectPageInfo.textContent = "Pagination inactive";
      return;
    }

    if (UI.inspectPrev) {
      UI.inspectPrev.disabled = pagination.has_previous !== true;
      UI.inspectPrev.dataset.offset = pagination.previous_offset == null ? "0" : String(pagination.previous_offset);
    }
    if (UI.inspectNext) {
      UI.inspectNext.disabled = pagination.has_next !== true;
      UI.inspectNext.dataset.offset = pagination.next_offset == null ? String(pagination.offset || 0) : String(pagination.next_offset);
    }

    const total = Number(pagination.total_rows || 0);
    const returned = Number(pagination.returned_rows || 0);
    const offset = Number(pagination.offset || 0);
    const start = returned > 0 ? offset + 1 : 0;
    const end = returned > 0 ? offset + returned : 0;
    const sortMode = pagination.sort_mode || inspectionPaginationState.sortMode;
    inspectionPaginationState.sortMode = sortMode;
    if (UI.inspectSort) UI.inspectSort.value = sortMode;
    if (UI.inspectPageInfo) {
      UI.inspectPageInfo.textContent = `Showing ${start}-${end} of ${total} UTXOs · ${pagination.limit || inspectionPaginationState.limit} per page · sort ${inspectionSortModeLabel(sortMode)}`;
    }
  }

  function inspectMono(text) {
    return `<span class="cc-inspect-mono">${escapeHtml(text == null ? "" : text)}</span>`;
  }

  function inspectCopyLink(value, label, head, tail) {
    const text = value == null || value === "" ? "" : String(value);
    if (!text || text === "none") return inspectMono(text || "none");
    const short = shortText(text, head, tail);
    return `<button type="button" class="cc-inspect-link-button cc-inspect-mono" title="Copy full ${escapeHtml(label)}" data-cc-inspect-copy-kind="${escapeHtml(label)}" data-cc-inspect-copy-value="${escapeHtml(text)}">${escapeHtml(short)}</button>`;
  }

  function humanizeInspectionText(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return "";
    return text.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  }

  function inspectionRowMetadata(row) {
    const metadata = row && row.metadata_area && row.metadata_area.metadata_kind === "programmable_kas_utxo_metadata_area_v1" ? row.metadata_area : null;
    return metadata || null;
  }

  function inspectionMetadataFieldValue(metadata, label) {
    const fields = metadata && Array.isArray(metadata.fields) ? metadata.fields : [];
    const target = String(label || "").toLowerCase();
    const found = fields.find(function (field) { return String(field && field.label || "").toLowerCase() === target; });
    return found && found.value != null ? String(found.value) : "";
  }

  function inspectionMetadataFieldValueAny(metadata, labels) {
    const list = Array.isArray(labels) ? labels : [labels];
    for (const label of list) {
      const value = inspectionMetadataFieldValue(metadata, label);
      if (value !== "") return value;
    }
    return "";
  }

  function inspectionMetadataTargetSatisfied(metadata) {
    const value = inspectionMetadataFieldValueAny(metadata, [
      "Target satisfied",
      "Recovery target satisfied",
      "Refund target satisfied"
    ]);
    if (!value) return null;
    if (/^(yes|true|satisfied)$/i.test(value)) return true;
    if (/^(no|false|not satisfied|not_satisfied)$/i.test(value)) return false;
    return null;
  }

  function inspectDetailKv(label, value) {
    const text = value == null || value === "" ? "—" : String(value);
    return `<div class="cc-inspect-kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(text)}</strong></div>`;
  }

  function inspectCopyValueHtml(label, value, copyKind) {
    const text = value == null || value === "" ? "" : String(value);
    if (!text) return "";
    return `
      <div class="cc-inspect-copy-field">
        <span class="cc-inspect-copy-label">${escapeHtml(label)}</span>
        <span class="cc-inspect-copy-value">${escapeHtml(text)}</span>
        <button type="button" class="cc-inspect-copy-button" data-cc-inspect-copy-kind="${escapeHtml(copyKind)}" data-cc-inspect-copy-value="${escapeHtml(text)}">Copy ${escapeHtml(label)}</button>
        <span class="cc-inspect-copy-status" aria-live="polite"></span>
      </div>
    `;
  }

  const PROGRAMMABLE_KAS_INSPECTOR_APP_LOAD_TARGETS = {
    programmable_kas_p2sh_owner_release_kas: {
      key: "owner_release",
      title: "P2SH Owner-Release KAS",
      cardId: "ccOwnerReleaseKasCard",
      statusId: "ccOwnerReleaseStatus",
      proofId: "ccOwnerReleaseProof",
      sourceOutpointId: "ccOwnerReleaseSourceOutpoint",
      covenantIdId: "ccOwnerReleaseCovenantId",
      buttonLabel: "Load Owner-Release app",
      help: "Load source outpoint and covenant ID into the P2SH Owner-Release KAS card."
    },
    programmable_kas_p2sh_absolute_time_lock_kas: {
      key: "absolute_time_lock",
      title: "Absolute Time Lock KAS",
      cardId: "ccAbsoluteTimeLockCard",
      statusId: "ccAbsoluteTimeLockStatus",
      proofId: "ccAbsoluteTimeLockProof",
      sourceOutpointId: "ccAbsoluteTimeLockSourceOutpoint",
      covenantIdId: "ccAbsoluteTimeLockCovenantId",
      buttonLabel: "Load Time-Lock app",
      help: "Load source outpoint, covenant ID, and lock target DAA into the Absolute Time Lock KAS card.",
      requiresTargetSatisfied: true,
      extraFields: [
        { fieldId: "ccAbsoluteTimeLockTargetDaa", labels: ["Lock target DAA"] }
      ]
    },
    programmable_kas_p2sh_relative_sequence_lock_kas: {
      key: "relative_sequence_lock",
      title: "Relative Sequence Lock KAS",
      cardId: "ccRelativeSequenceLockCard",
      statusId: "ccRelativeSequenceStatus",
      proofId: "ccRelativeSequenceProof",
      sourceOutpointId: "ccRelativeSequenceSourceOutpoint",
      covenantIdId: "ccRelativeSequenceCovenantId",
      buttonLabel: "Load Sequence app",
      help: "Load source outpoint, covenant ID, and relative DAA delta into the Relative Sequence Lock KAS card.",
      requiresTargetSatisfied: true,
      extraFields: [
        { fieldId: "ccRelativeSequenceDaaDelta", labels: ["Relative DAA delta", "Lock DAA delta"] }
      ]
    },
    programmable_kas_p2sh_allowed_destination_kas: {
      key: "allowed_destination",
      title: "Allowed Destination KAS",
      cardId: "ccAllowedDestinationCard",
      statusId: "ccAllowedDestinationStatus",
      proofId: "ccAllowedDestinationProof",
      sourceOutpointId: "ccAllowedDestinationSourceOutpoint",
      covenantIdId: "ccAllowedDestinationCovenantId",
      buttonLabel: "Load Destination app",
      help: "Load source outpoint and covenant ID into the Allowed Destination KAS card."
    },
    programmable_kas_p2sh_immediate_recovery_kas: {
      key: "immediate_recovery",
      title: "Immediate Recovery KAS",
      cardId: "ccImmediateRecoveryCard",
      statusId: "ccImmediateRecoveryStatus",
      proofId: "ccImmediateRecoveryProof",
      sourceOutpointId: "ccImmediateRecoverySourceOutpoint",
      covenantIdId: "ccImmediateRecoveryCovenantId",
      buttonLabel: "Load Recovery app",
      help: "Load source outpoint and covenant ID into the Immediate Recovery KAS card."
    },
    programmable_kas_p2sh_escrow_refund_kas: {
      key: "escrow_refund",
      title: "Escrow / Refund KAS",
      cardId: "ccEscrowRefundCard",
      statusId: "ccEscrowRefundStatus",
      proofId: "ccEscrowRefundProof",
      sourceOutpointId: "ccEscrowRefundSourceOutpoint",
      covenantIdId: "ccEscrowRefundCovenantId",
      buttonLabel: "Load Escrow app",
      help: "Load source outpoint and covenant ID into the Escrow / Refund KAS card."
    },
    programmable_kas_p2sh_absolute_time_lock_allowed_destination_kas: {
      key: "c5_time_lock_allowed_destination",
      title: "Time Lock + Allowed Destination KAS",
      cardId: "ccTimeLockAllowedDestinationCard",
      statusId: "ccC5Status",
      proofId: "ccC5Proof",
      sourceOutpointId: "ccC5SourceOutpoint",
      covenantIdId: "ccC5CovenantId",
      buttonLabel: "Load Time Lock + Destination app",
      help: "Load source outpoint, covenant ID, and lock target DAA into the Time Lock + Allowed Destination KAS card.",
      requiresTargetSatisfied: true,
      extraFields: [
        { fieldId: "ccC5LockTargetDaa", labels: ["Lock target DAA"] }
      ]
    },
    programmable_kas_p2sh_owner_release_delayed_recovery_kas: {
      key: "c6_owner_release_delayed_recovery",
      title: "Owner Release + Delayed Recovery KAS",
      cardId: "ccOwnerReleaseDelayedRecoveryCard",
      statusId: "ccC6Status",
      proofId: "ccC6Proof",
      sourceOutpointId: "ccC6SourceOutpoint",
      covenantIdId: "ccC6CovenantId",
      buttonLabel: "Load C6 app",
      help: "Load source outpoint and covenant ID into the Owner Release + Delayed Recovery KAS card."
    },
    programmable_kas_protect_kas_v1: {
      key: "protect_kas",
      title: "Protect KAS",
      cardId: "ccProtectKasCard",
      statusId: "ccProtectKasStatus",
      proofId: "ccProtectKasProof",
      sourceOutpointId: "ccProtectKasReleaseOutpoint",
      covenantIdId: "ccProtectKasReleaseCovenantId",
      buttonLabel: "Load Protect KAS app",
      help: "Load source outpoint and covenant ID into the Protect KAS release fields."
    }
  };

  function isProgrammableKasP2shOwnerReleaseRow(row) {
    return !!row && row.classification === "programmable_kas_p2sh_owner_release_kas";
  }

  function programmableKasInspectionLoadTarget(row) {
    const classification = row && row.classification ? String(row.classification) : "";
    return PROGRAMMABLE_KAS_INSPECTOR_APP_LOAD_TARGETS[classification] || null;
  }

  function programmableKasInspectionLoadExtraFields(target, metadata) {
    return (target && Array.isArray(target.extraFields) ? target.extraFields : []).map(function (item) {
      return {
        fieldId: item.fieldId,
        value: inspectionMetadataFieldValueAny(metadata, item.labels || [])
      };
    }).filter(function (item) {
      return item.fieldId && item.value;
    });
  }

  function rowReleaseIdentifiersHtml(row) {
    if (!row || row.covenant_present !== true || !row.covenant_id) return "";
    const outpointText = row.outpoint && row.outpoint.text ? String(row.outpoint.text) : "";
    const covenantId = String(row.covenant_id || "");
    if (!outpointText || !covenantId) return "";
    const target = programmableKasInspectionLoadTarget(row);
    if (!target) return "";
    const metadata = inspectionRowMetadata(row);
    const targetSatisfied = inspectionMetadataTargetSatisfied(metadata);
    const releaseKnownBlocked = target.requiresTargetSatisfied === true && targetSatisfied === false;
    const extraFields = programmableKasInspectionLoadExtraFields(target, metadata);
    const extraFieldText = extraFields.length ? JSON.stringify(extraFields) : "[]";
    const disabledAttr = releaseKnownBlocked ? " disabled aria-disabled=\"true\"" : "";
    const buttonText = releaseKnownBlocked ? "Release not ready" : target.buttonLabel;
    const help = releaseKnownBlocked
      ? `${target.title} release is not ready yet because its configured target is not satisfied.`
      : target.help;
    return `
      <tr class="cc-inspect-detail-row cc-inspect-compact-action-row">
        <td colspan="5">
          <div class="cc-inspect-compact-action" data-cc-inspect-release-fields="covenant_release_action_v1">
            <span>
              <strong>${escapeHtml(target.title)} action</strong>
              <small>${escapeHtml(help)}</small>
            </span>
            <button type="button" class="cc-inspect-copy-button" data-cc-programmable-kas-app-load="1" data-cc-programmable-kas-app-key="${escapeHtml(target.key)}" data-cc-programmable-kas-app-outpoint="${escapeHtml(outpointText)}" data-cc-programmable-kas-app-covenant-id="${escapeHtml(covenantId)}" data-cc-programmable-kas-app-extra-fields="${escapeHtml(extraFieldText)}"${disabledAttr}>${escapeHtml(buttonText)}</button>
            <span class="cc-inspect-copy-status" aria-live="polite"></span>
          </div>
        </td>
      </tr>
    `;
  }

  async function handleInspectionCopyClick(event) {
    const button = event && event.target && event.target.closest ? event.target.closest("[data-cc-inspect-copy-value]") : null;
    if (!button) return;
    const value = String(button.getAttribute("data-cc-inspect-copy-value") || "");
    const field = button.closest ? (button.closest(".cc-inspect-copy-field") || button.closest(".cc-inspect-compact-action")) : null;
    const status = field ? field.querySelector(".cc-inspect-copy-status") : null;
    if (!value) {
      if (status) status.textContent = "missing value";
      return;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      if (status) status.textContent = "clipboard unavailable";
      return;
    }
    await navigator.clipboard.writeText(value);
    if (status) status.textContent = "copied";
  }

  async function handleProgrammableKasInspectionAppLoadClick(event) {
    const button = event && event.target && event.target.closest ? event.target.closest("[data-cc-programmable-kas-app-load]") : null;
    if (!button || button.disabled) return;
    const appKey = String(button.getAttribute("data-cc-programmable-kas-app-key") || "").trim();
    const target = Object.values(PROGRAMMABLE_KAS_INSPECTOR_APP_LOAD_TARGETS).find(function (item) { return item.key === appKey; });
    const outpoint = String(button.getAttribute("data-cc-programmable-kas-app-outpoint") || "").trim();
    const covenantId = String(button.getAttribute("data-cc-programmable-kas-app-covenant-id") || "").trim().toLowerCase();
    const field = button.closest ? button.closest(".cc-inspect-compact-action") : null;
    const status = field ? field.querySelector(".cc-inspect-copy-status") : null;
    if (!target || !outpoint || !/^[0-9a-f]{64}$/i.test(covenantId)) {
      if (status) status.textContent = "missing release data";
      return;
    }

    const sourceOutpointField = $(target.sourceOutpointId);
    const covenantIdField = $(target.covenantIdId);
    if (sourceOutpointField) sourceOutpointField.value = outpoint;
    if (covenantIdField) covenantIdField.value = covenantId;

    let extraFields = [];
    try {
      extraFields = JSON.parse(button.getAttribute("data-cc-programmable-kas-app-extra-fields") || "[]");
    } catch (_) {
      extraFields = [];
    }
    if (Array.isArray(extraFields)) {
      extraFields.forEach(function (item) {
        if (!item || !item.fieldId) return;
        const fieldNode = $(item.fieldId);
        if (fieldNode && item.value != null && item.value !== "") fieldNode.value = String(item.value);
      });
    }

    const appConfig = Array.isArray(PROGRAMMABLE_KAS_APP_CONFIGS) ? PROGRAMMABLE_KAS_APP_CONFIGS.find(function (config) { return config.key === target.key; }) : null;
    programmableKasAppBuildState[target.key] = {};
    if (appConfig) {
      [appConfig.submitButtonId, appConfig.releaseSubmitButtonId, appConfig.refundSubmitButtonId, appConfig.recoverySubmitButtonId].forEach(function (id) {
        const submitButton = id ? $(id) : null;
        if (submitButton) submitButton.disabled = true;
      });
    }

    const card = $(target.cardId);
    if (card && "open" in card) card.open = true;
    const proofBox = $(target.proofId);
    if (proofBox) {
      proofBox.classList.remove("hidden");
      proofBox.textContent = JSON.stringify({
        proof_kind: "ui_app_wiring_g_inspector_loaded_into_matching_programmable_kas_app_v1",
        app_key: target.key,
        app_title: target.title,
        release_target_card: target.cardId,
        source_outpoint: outpoint,
        expected_covenant_id: covenantId,
        loaded_extra_fields: Array.isArray(extraFields) ? extraFields : [],
        signing: "none",
        broadcasting: "none",
        minting: "none",
        wallet_mutation: "none"
      }, null, 2);
    }
    setText($(target.statusId), `${target.title} source loaded. Build release, then sign and release from this wallet when ready.`);
    if (status) status.textContent = "loaded into matching app";
  }

  function inspectMetadataFieldHtml(field) {
    if (!field || field.value == null || field.value === "") return "";
    const label = field.label == null || field.label === "" ? "Metadata" : String(field.label);
    const value = String(field.value);
    const valueKind = field.value_kind ? ` · ${String(field.value_kind)}` : "";
    return `
      <div class="cc-inspect-metadata-field">
        <span>${escapeHtml(label)}${escapeHtml(valueKind)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function rowMetadataAreaHtml(row) {
    const metadata = row && row.metadata_area ? row.metadata_area : null;
    if (!metadata || metadata.metadata_kind !== "programmable_kas_utxo_metadata_area_v1") return "";
    const title = metadata.display_title || row.label || row.classification || "UTXO metadata";
    const policySummary = metadata.policy_summary || row.warning || "Read-only UTXO metadata.";
    const summary = metadata.source_record_kind
      ? `${humanizeInspectionText(metadata.source_record_kind)} · open details`
      : "Open details for policy metadata";
    const statusBits = [
      metadata.metadata_status,
      metadata.source_record_kind ? `record=${metadata.source_record_kind}` : null,
      row.covenant_present === true ? "covenant-bearing" : "native"
    ].filter(Boolean).join(" · ");
    const metadataFields = asArray(metadata.fields);
    const hasPurposeField = metadataFields.some(function (field) {
      const label = String(field && field.label || "").toLowerCase();
      return label === "what this utxo covenant does" || label === "policy summary";
    });
    const allFields = hasPurposeField
      ? metadataFields
      : [{ label: "Policy summary", value: policySummary, value_kind: "details" }].concat(metadataFields);
    const fields = allFields
      .map(inspectMetadataFieldHtml)
      .filter(Boolean)
      .join("");
    const warning = metadata.warning ? `<div class="cc-inspect-metadata-warning">${escapeHtml(metadata.warning)}</div>` : "";
    // Inspector metadata rows start collapsed and keep long policy descriptions inside details.
    return `
      <tr class="cc-inspect-detail-row cc-inspect-metadata-row">
        <td colspan="5">
          <details class="cc-inspect-metadata-card" data-cc-inspect-metadata-area="programmable_kas_utxo_metadata_area_v1">
            <summary>
              <span class="cc-inspect-metadata-title">${escapeHtml(title)}</span>
              <span class="cc-inspect-metadata-summary">${escapeHtml(summary)}</span>
            </summary>
            ${warning}
            ${statusBits ? `<div class="cc-inspect-muted">${escapeHtml(statusBits)}</div>` : ""}
            ${fields ? `<div class="cc-inspect-metadata-grid">${fields}</div>` : ""}
          </details>
        </td>
      </tr>
    `;
  }

  function rowDetailsHtml(row, verified, role, symbol, display) {
    if (!verified || verified.verification_status !== "verified_p2sh_state_envelope_match") return "";
    const decoded = verified.decoded_fields || {};
    const isHolder = role === "holder";
    const address = row.inspection_address || verified.holder_address || verified.controller_address || null;
    const detailDecimals = display && display.decimals != null ? display.decimals : decoded.decimals != null ? decoded.decimals : 0;
    const stateSchema = isHolder
      ? (decoded.holder_state_schema || "oma_l1_token_state_v1")
      : (decoded.controller_state_schema || "oma_l1_token_controller_state_v1");
    const maxSupplyRaw = display && display.max_supply_raw != null ? display.max_supply_raw : decoded.max_supply_raw || null;
    const issuedSupplyRaw = display && display.issued_supply_raw != null ? display.issued_supply_raw : decoded.issued_supply_raw || null;
    let remainingSupplyRaw = null;
    if (maxSupplyRaw != null && issuedSupplyRaw != null) {
      try {
        const remaining = BigInt(maxSupplyRaw) - BigInt(issuedSupplyRaw);
        remainingSupplyRaw = remaining >= 0n ? remaining.toString() : null;
      } catch (e) {
        remainingSupplyRaw = null;
      }
    }
    const items = [
      ["Role", role || "verified"],
      ["Token", symbol || decoded.token_symbol || "OMA L1"],
      ["Token name", verified.token_name || decoded.token_name || "—"],
      ["Asset covenant ID", verified.live_asset_covenant_id || row.covenant_id || decoded.asset_covenant_id || "—"],
      ["Outpoint", row.outpoint && row.outpoint.text ? row.outpoint.text : "—"],
      ["Tracked address", address || "—"],
      ["Carrier KAS", row.amount_kas || "0"],
      ["Carrier sompi", row.amount_sompi || verified.holder_carrier_sompi || verified.controller_carrier_sompi || "—"],
      ["State schema", stateSchema],
      ["Verification", verified.verification_status],
      ["P2SH script hash", verified.p2sh_script_public_key_json_sha256 || verified.live_script_public_key_json_sha256 || "—"],
      ["Redeem script hash", verified.redeem_script_hex_sha256 || "—"],
      ["Normal KAS send", row.normal_send_eligible ? "eligible" : "blocked"],
      ["Token transfer", decoded.token_transfer_enabled === true ? "enabled" : "disabled until transfer proof"]
    ];
    if (isHolder) {
      items.splice(7, 0,
        ["Amount human", display && display.amount_human != null ? `${display.amount_human} ${symbol}` : "—"],
        ["Amount raw", display && display.amount_raw != null ? display.amount_raw : decoded.amount_raw || "—"],
        ["Decimals", display && display.decimals != null ? display.decimals : decoded.decimals != null ? decoded.decimals : "—"],
        ["Owner", decoded.owner_identifier || "—"],
        ["Issuer", verified.issuer_identifier || decoded.issuer_identifier || "—"],
        ["Controller outpoint", verified.controller_outpoint || "—"],
        ["Controller address", verified.controller_address || "—"],
        ["Controller state schema", verified.controller_state_schema || decoded.controller_state_schema || "—"],
        ["Max supply", verified.max_supply_human != null ? `${verified.max_supply_human} ${symbol}` : verified.max_supply_raw || "—"],
        ["Issued supply", verified.issued_supply_human != null ? `${verified.issued_supply_human} ${symbol}` : verified.issued_supply_raw || "—"],
        ["Controller row visibility", "metadata reference only unless active wallet is issuer"]
      );
    } else {
      items.splice(7, 0,
        ["Max supply", display && display.max_supply_human != null ? `${display.max_supply_human} ${symbol}` : maxSupplyRaw || "—"],
        ["Max supply raw", maxSupplyRaw || "—"],
        ["Issued supply", display && display.issued_supply_human != null ? `${display.issued_supply_human} ${symbol}` : issuedSupplyRaw || "—"],
        ["Issued supply raw", issuedSupplyRaw || "—"],
        ["Remaining issuable", remainingSupplyRaw != null ? `${formatRawTokenAmountHuman(remainingSupplyRaw, detailDecimals)} ${symbol}` : "—"],
        ["Decimals", detailDecimals],
        ["Transfer rule", decoded.transfer_rule || "—"],
        ["Issuer", decoded.issuer_identifier || "—"],
        ["Policy hash", decoded.policy_hash || "—"],
        ["Controller state schema", decoded.controller_state_schema || stateSchema],
        ["Holder state schema", decoded.holder_state_schema || "—"],
        ["Controller state", "policy/control state"],
        ["Token amount", "none; controller is not holder balance"]
      );
    }
    return `
      <tr class="cc-inspect-detail-row">
        <td colspan="5">
          <details>
            <summary>${escapeHtml(isHolder ? "Holder token metadata" : "Controller metadata")}</summary>
            <div class="cc-inspect-detail-grid">
              ${items.map(function (item) { return inspectDetailKv(item[0], item[1]); }).join("")}
            </div>
          </details>
        </td>
      </tr>
    `;
  }

  function rowHtml(row) {
    const normalSend = row.normal_send_eligible ? "eligible" : "blocked";
    const registryMatch = row.registry_match === true ? "registry match" : row.covenant_present ? "registry unknown" : "native";
    const proofStatus = row.proof_status ? humanizeInspectionText(row.proof_status) : "";
    const verified = row.verified_oma_l1_state || null;
    const verifiedOk = verified && verified.verification_status === "verified_p2sh_state_envelope_match";
    const role = verifiedOk ? String(verified.role || "").toLowerCase() : "";
    const symbol = verifiedOk ? String(verified.token_symbol || "OMA L1") : "";
    const display = verifiedOk && verified.display_amounts ? verified.display_amounts : null;
    const metadata = inspectionRowMetadata(row);
    const metadataTitle = metadata && metadata.display_title ? String(metadata.display_title) : "";
    const metadataSummary = metadata && row.covenant_present ? "Open details below for policy and tracking metadata." : "";
    const classification = verifiedOk
      ? (role === "controller" ? `${symbol} controller` : `${symbol} holder token`)
      : (metadataTitle || row.label || row.classification || "unknown");
    const amount = verifiedOk
      ? (role === "holder" && display && display.amount_human ? `${display.amount_human} ${symbol}` : `${row.amount_kas || "0"} KAS carrier`)
      : `${row.amount_kas || "0"} KAS`;
    const secondary = verifiedOk
      ? (role === "holder" && display ? `carrier ${row.amount_kas || "0"} KAS · raw ${display.amount_raw || "0"}` : "policy/control state")
      : row.covenant_present
        ? `Covenanted KAS · normal send ${normalSend}${proofStatus ? ` · ${proofStatus}` : ""}`
        : "Native KAS output";
    const classificationHelp = verifiedOk
      ? "verified live P2SH match"
      : row.covenant_present
        ? (metadataSummary || `${humanizeInspectionText(row.classification || row.label || "Covenant-bearing KAS")}. Use the matching app to release.`)
        : "Native KAS output.";
    const addressLine = row.inspection_address ? `<br><small class="cc-inspect-muted">${escapeHtml(row.address_source || "address")}: ${inspectMono(shortText(row.inspection_address, 16, 12))}</small>` : "";
    return `
      <tr class="${verifiedOk ? "cc-inspect-verified-row" : ""}">
        <td>${inspectCopyLink(row.outpoint && row.outpoint.text, "outpoint", 18, 10)}${addressLine}</td>
        <td>${escapeHtml(amount)}${secondary ? `<br><small class="cc-inspect-row-help">${escapeHtml(secondary)}</small>` : ""}</td>
        <td>${escapeHtml(classification)}<small class="cc-inspect-row-help">${escapeHtml(classificationHelp)}</small></td>
        <td>${row.covenant_id ? inspectCopyLink(row.covenant_id, "covenant ID", 16, 12) : inspectMono("none")}</td>
        <td>${escapeHtml(normalSend)}</td>
      </tr>
      ${rowReleaseIdentifiersHtml(row)}
      ${rowMetadataAreaHtml(row)}
      ${rowDetailsHtml(row, verified, role, symbol, display)}
    `;
  }

  function renderInspection(data, httpStatus) {
    ensureInspectionPanel();

    if (!data || data.ok !== true) {
      const reason = data && data.reason ? data.reason : "inspection_failed";
      const errorJson = {
        ok: false,
        http_status: httpStatus,
        reason,
        response: data || null,
        signing_enabled: false,
        broadcasting_enabled: false,
        minting_enabled: false
      };
      setText(UI.inspectStatus, `blocked: ${reason}`);
      if (UI.inspectSummary) {
        UI.inspectSummary.innerHTML = `Read-only inspection blocked: <strong>${escapeHtml(reason)}</strong>`;
      }
      if (UI.inspectRows) {
        UI.inspectRows.innerHTML = `<tr><td colspan="5">${escapeHtml(reason)}</td></tr>`;
      }
      renderInspectionPaginationControls({ pagination: { pagination_kind: "covenant_utxo_inspection_pagination_v1", enabled: true, total_rows: 0, returned_rows: 0, limit: inspectionPaginationState.limit, offset: inspectionPaginationState.offset, has_previous: false, has_next: false } });
      setText(UI.inspectJson, JSON.stringify(errorJson, null, 2));
      return;
    }

    const activeRows = Array.isArray(data.rows) ? data.rows : [];
    const rows = Array.isArray(data.display_rows) ? data.display_rows : activeRows;
    const activeCount = activeRows.length;
    const verifiedCount = data.verified_oma_l1_reconciliation && Number.isFinite(Number(data.verified_oma_l1_reconciliation.verified_rows))
      ? Number(data.verified_oma_l1_reconciliation.verified_rows)
      : 0;
    const programmableInspection = data.programmable_kas_p2sh_owner_release_inspection || null;
    const programmableRows = programmableInspection && Array.isArray(programmableInspection.rows) ? programmableInspection.rows.filter(isProgrammableKasP2shOwnerReleaseRow) : [];
    const pageInfo = data.pagination && data.pagination.enabled === true
      ? ` · page ${Number(data.pagination.offset || 0) + 1}-${Number(data.pagination.offset || 0) + Number(data.pagination.returned_rows || activeCount)} of ${Number(data.pagination.total_rows || activeCount)}`
      : "";
    setText(UI.inspectStatus, `loaded: ${activeCount} active-wallet UTXOs${pageInfo}${verifiedCount ? ` · ${verifiedCount} verified OMA L1 rows` : ""}${programmableRows.length ? ` · ${programmableRows.length} P2SH Owner-Release KAS row${programmableRows.length === 1 ? "" : "s"}` : ""}`);
    if (UI.inspectSummary) UI.inspectSummary.innerHTML = inspectionSummaryHtml(data);
    if (UI.inspectRows) {
      UI.inspectRows.innerHTML = rows.length
        ? rows.map(rowHtml).join("")
        : `<tr><td colspan="5">No UTXOs returned for this active wallet.</td></tr>`;
    }
    renderInspectionPaginationControls(data);
    setText(UI.inspectJson, JSON.stringify({
      ok: data.ok,
      inspection_kind: data.inspection_kind,
      application_status: data.application_status,
      wallet_id: data.wallet_id,
      wallet_type: data.wallet_type,
      network: data.network,
      networkId: data.networkId,
      address: data.address,
      sdk_version: data.sdk_version,
      node: data.node,
      counts: data.counts,
      pagination: data.pagination || null,
      known_lab_proof: data.known_lab_proof,
      template_registry: data.template_registry,
      verified_oma_l1_reconciliation: data.verified_oma_l1_reconciliation || null,
      server_tracked_oma_l1_reconciliation: data.server_tracked_oma_l1_reconciliation || null,
      programmable_kas_p2sh_owner_release_inspection: data.programmable_kas_p2sh_owner_release_inspection || null,
      active_wallet_rows: activeRows,
      rows: rows,
      signing_enabled: data.signing_enabled,
      broadcasting_enabled: data.broadcasting_enabled,
      minting_enabled: data.minting_enabled
    }, null, 2));
  }

  function setInspectionPageOffset(offset) {
    const parsed = Number(offset);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return;
    inspectionPaginationState.offset = parsed;
  }

  function resetInspectionPagination() {
    inspectionPaginationState.offset = 0;
  }

  function handleInspectionSortChange(event) {
    const select = event && event.currentTarget ? event.currentTarget : null;
    const nextSortMode = select && typeof select.value === "string" ? select.value : "amount_desc_outpoint";
    if (!["amount_desc_outpoint", "amount_asc_outpoint", "utxo_asc"].includes(nextSortMode)) return;
    inspectionPaginationState.sortMode = nextSortMode;
    inspectionPaginationState.offset = 0;
    loadCovenantInspection();
  }

  function handleInspectionPageButton(event) {
    const button = event && event.currentTarget ? event.currentTarget : null;
    if (!button || button.disabled) return;
    const nextOffset = button.dataset && button.dataset.offset != null ? button.dataset.offset : "0";
    setInspectionPageOffset(nextOffset);
    loadCovenantInspection();
  }

  async function loadCovenantInspection() {
    ensureInspectionPanel();
    setText(UI.inspectStatus, "loading");
    try {
      const params = new URLSearchParams({
        limit: String(inspectionPaginationState.limit),
        offset: String(inspectionPaginationState.offset),
        sort: String(inspectionPaginationState.sortMode || "amount_desc_outpoint")
      });
      const response = await fetch(`/api/covenants/utxos?${params.toString()}`, {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      const data = await response.json().catch(function () {
        return { ok: false, reason: "invalid_json_response" };
      });
      if (data && data.ok === true) {
        const displayRows = Array.isArray(data.rows) ? data.rows.slice() : [];
        const programmableKasAddressSource = data.programmable_kas_p2sh_owner_release || null;
        const programmableKasAddress = typeof programmableKasAddressSource === "string"
          ? programmableKasAddressSource
          : (programmableKasAddressSource && typeof programmableKasAddressSource.address === "string" ? programmableKasAddressSource.address : null);
        if (programmableKasAddress) {
          try {
            const programmableInspection = await fetchInspectionForAddress(programmableKasAddress, false);
            data.programmable_kas_p2sh_owner_release_inspection = Object.assign({ http_status: programmableInspection.http_status }, programmableInspection.body || {});
            if (programmableInspection.body && programmableInspection.body.ok === true && Array.isArray(programmableInspection.body.rows)) {
              displayRows.push.apply(displayRows, programmableInspection.body.rows);
            }
          } catch (e) {
            data.programmable_kas_p2sh_owner_release_inspection = {
              ok: false,
              reason: String(e && e.message ? e.message : e),
              signing_enabled: false,
              broadcasting_enabled: false,
              minting_enabled: false
            };
          }
        }
        const serverTrackedReconciliation = await buildServerTrackedOmaL1InspectionReconciliation();
        data.verified_oma_l1_reconciliation = serverTrackedReconciliation;
        data.server_tracked_oma_l1_reconciliation = serverTrackedReconciliation;
        if (Array.isArray(serverTrackedReconciliation.rows) && serverTrackedReconciliation.rows.length) {
          displayRows.push.apply(displayRows, serverTrackedReconciliation.rows);
        }
        data.display_rows = omaL1DedupeRowsByOutpoint(displayRows);
      }
      renderInspection(data, response.status);
    } catch (e) {
      renderInspection({ ok: false, reason: String(e && e.message ? e.message : e) }, 0);
    }
  }


  const protectKasState = {
    build: null,
    releaseBuild: null,
    releaseMode: "lowlevel_genesis"
  };

  const PROTECT_KAS_DEFAULT_FEE_RESERVE_SOMPI = "1000000";
  const PROTECT_KAS_P2SH_OWNER_RELEASE_FEE_RESERVE_SOMPI = "10000000";

  function setProtectKasStatus(message) {
    setText(UI.protectKasStatus, message);
  }

  function setProtectKasProof(packet) {
    if (!UI.protectKasProof) return;
    UI.protectKasProof.classList.remove("hidden");
    setText(UI.protectKasProof, JSON.stringify(packet, null, 2));
  }

  function protectKasSetSubmitEnabled(button, enabled) {
    if (button) button.disabled = enabled !== true;
  }

  function kasToSompiText(kasText) {
    const raw = String(kasText == null ? "" : kasText).trim();
    if (!/^[0-9]+(?:\.[0-9]{1,8})?$/.test(raw)) {
      throw new Error("protect_kas_amount_invalid");
    }
    const parts = raw.split(".");
    const whole = parts[0] || "0";
    const frac = (parts[1] || "").padEnd(8, "0");
    const sompi = `${whole}${frac}`.replace(/^0+(?=\d)/, "") || "0";
    if (!/^[0-9]+$/.test(sompi) || BigInt(sompi) <= 0n) {
      throw new Error("protect_kas_amount_not_positive");
    }
    return sompi;
  }

  async function protectKasHttpJson(method, url, body) {
    const headers = { "Accept": "application/json" };
    const init = { method, credentials: "include", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { ok: false, reason: "invalid_json_response" }; }
    if (!response.ok || !json || json.ok !== true) {
      const reason = json && (json.reason || json.error) ? String(json.reason || json.error) : `http_${response.status}`;
      const err = new Error(reason);
      err.http_status = response.status;
      err.body = json;
      throw err;
    }
    return { http_status: response.status, body: json };
  }

  async function protectKasSdk() {
    if (window.kaspaToccataReady && typeof window.kaspaToccataReady.then === "function") {
      await window.kaspaToccataReady;
    }
    const sdk = window.kaspaToccata;
    if (!sdk || typeof sdk.Transaction !== "function" || typeof sdk.PrivateKey !== "function" || typeof sdk.createInputSignature !== "function") {
      throw new Error("protect_kas_toccata_sdk_missing_required_signing_surface");
    }
    return sdk;
  }

  function protectKasNetworkMeta(raw) {
    const shared = window.CwNetworkShared;
    if (!shared || typeof shared.getNetworkMeta !== "function") return null;
    return shared.getNetworkMeta(raw);
  }

  async function protectKasActiveKeyring(sdk) {
    const statusResult = await protectKasHttpJson("GET", "/api/wallet/status");
    const status = statusResult.body;
    const keyring = readUnlockedKeyringShape();
    if (!keyring.ok) throw new Error(keyring.reason || "wallet_locked");
    if (String(keyring.wallet_id || "") !== String(status.wallet_id || "")) {
      throw new Error("protect_kas_wallet_session_mismatch");
    }
    const priv0 = new sdk.PrivateKey(keyring.priv0_hex);
    const networkMeta = protectKasNetworkMeta(status.network || status.net || status.networkId || "");
    const walletNetworkLabel = networkMeta && networkMeta.walletNetworkLabel ? String(networkMeta.walletNetworkLabel) : "";
    if (walletNetworkLabel && typeof priv0.toAddress === "function") {
      const derivedAddress = priv0.toAddress(walletNetworkLabel).toString();
      if (String(status.address0 || "") && derivedAddress !== String(status.address0 || "")) {
        throw new Error("protect_kas_active_wallet_key_mismatch");
      }
    }
    return { status, priv0, wallet_id: status.wallet_id || null, address0: status.address0 || null, networkId: status.networkId || status.network || null };
  }

  async function protectKasSignSafeJson(txToSignSafeJson, signInputIndexes) {
    const sdk = await protectKasSdk();
    const active = await protectKasActiveKeyring(sdk);
    const tx = sdk.Transaction.deserializeFromSafeJSON(String(txToSignSafeJson || ""));
    const indexes = asArray(signInputIndexes).map(function (value) { return Number(value); }).filter(function (value) { return Number.isInteger(value) && value >= 0; });
    if (!indexes.length) throw new Error("protect_kas_sign_input_indexes_missing");
    const before = indexes.map(function (index) {
      return { input_index: index, signatureScript_empty_before: !String(tx.inputs[index] && tx.inputs[index].signatureScript ? tx.inputs[index].signatureScript : "") };
    });
    indexes.forEach(function (index) {
      tx.inputs[index].signatureScript = sdk.createInputSignature(tx, index, active.priv0, null);
    });
    if (typeof tx.finalize === "function") tx.finalize();
    const signedSafeJson = tx.serializeToSafeJSON();
    const signedSafeJsonSha256 = await sha256Text(signedSafeJson);
    sdk.Transaction.deserializeFromSafeJSON(signedSafeJson);
    const after = indexes.map(function (index) {
      const sig = String(tx.inputs[index] && tx.inputs[index].signatureScript ? tx.inputs[index].signatureScript : "");
      return { input_index: index, signatureScript_present_after: !!sig, signatureScript_length: sig.length };
    });
    return { signedSafeJson, signedSafeJsonSha256, before, after, wallet_id: active.wallet_id, address0: active.address0, networkId: active.networkId };
  }

  async function protectKasSignP2shOwnerReleaseSafeJson(txToSignSafeJson, redeemScriptHex) {
    const sdk = await protectKasSdk();
    if (!sdk.ScriptBuilder || typeof sdk.ScriptBuilder.fromScript !== "function") {
      throw new Error("protect_kas_p2sh_script_builder_missing");
    }
    const active = await protectKasActiveKeyring(sdk);
    const tx = sdk.Transaction.deserializeFromSafeJSON(String(txToSignSafeJson || ""));
    const redeemScript = sdk.ScriptBuilder.fromScript(String(redeemScriptHex || ""));
    const before = [{ input_index: 0, signatureScript_empty_before: !String(tx.inputs[0] && tx.inputs[0].signatureScript ? tx.inputs[0].signatureScript : "") }];
    tx.inputs[0].signatureScript = redeemScript.encodePayToScriptHashSignatureScript(new Uint8Array(65));
    const signature = sdk.createInputSignature(tx, 0, active.priv0, null);
    tx.inputs[0].signatureScript = redeemScript.encodePayToScriptHashSignatureScript(signature);
    if (typeof tx.finalize === "function") tx.finalize();
    const signedSafeJson = tx.serializeToSafeJSON();
    const signedSafeJsonSha256 = await sha256Text(signedSafeJson);
    sdk.Transaction.deserializeFromSafeJSON(signedSafeJson);
    const sig = String(tx.inputs[0] && tx.inputs[0].signatureScript ? tx.inputs[0].signatureScript : "");
    const after = [{ input_index: 0, signatureScript_present_after: !!sig, signatureScript_length: sig.length }];
    return { signedSafeJson, signedSafeJsonSha256, before, after, wallet_id: active.wallet_id, address0: active.address0, networkId: active.networkId };
  }

  function protectKasBuildProof(build, httpStatus) {
    return {
      proof_kind: "cc_protect_kas_1d_build_protected_kas_preview_v1",
      build_http_status: httpStatus,
      ok: build && build.ok === true,
      build_kind: build && build.build_kind,
      application_status: build && build.application_status,
      networkId: build && build.networkId,
      fromAddress: build && build.fromAddress,
      destinationAddress: build && build.destinationAddress,
      destination_address_source: build && build.destination_address_source,
      changeAddress: build && build.changeAddress,
      amount_kas: build && build.amount_kas,
      amount_sompi: build && build.amount_sompi,
      covenant_id: build && build.covenant_id,
      selected_outpoint_key: build && build.selectedSource && build.selectedSource.outpoint_key,
      output_0_covenant_present: build && build.outputs && build.outputs[0] ? build.outputs[0].covenant_present === true : null,
      output_1_covenant_present: build && build.outputs && build.outputs[1] ? build.outputs[1].covenant_present === true : null,
      submit_route_enabled: !!(build && build.submit_route),
      signInputIndexes: build && build.signInputIndexes,
      private_key_printed: false,
      tx_to_sign_safe_json_printed: false,
      signed_transaction_json_printed: false,
      signature_script_printed: false,
      submit_token_printed: false,
      broadcasting: "none",
      minting: "none"
    };
  }

  async function protectKasBuild() {
    protectKasSetSubmitEnabled(UI.protectKasSubmitButton, false);
    protectKasState.build = null;
    const amountSompi = kasToSompiText(readField(UI.protectKasAmountKas));
    const destinationAddress = readField(UI.protectKasDestinationAddress);
    const payload = {
      amount_sompi: amountSompi,
      fee_reserve_sompi: PROTECT_KAS_DEFAULT_FEE_RESERVE_SOMPI
    };
    if (destinationAddress) payload.destination_address = destinationAddress;
    setProtectKasStatus("Building protected KAS transaction preview...");
    const result = await protectKasHttpJson("POST", "/api/covenants/lowlevel-genesis/build", payload);
    protectKasState.build = result.body;
    protectKasSetSubmitEnabled(UI.protectKasSubmitButton, true);
    setProtectKasStatus("Build ready. Review proof, then sign and transfer protected KAS.");
    setProtectKasProof(protectKasBuildProof(result.body, result.http_status));
  }

  async function protectKasSubmit() {
    const build = protectKasState.build;
    if (!build || !build.txToSignSafeJson || !build.submit_token) throw new Error("protect_kas_build_required_before_submit");
    setProtectKasStatus("Signing locally and transferring protected KAS...");
    protectKasSetSubmitEnabled(UI.protectKasSubmitButton, false);
    const signed = await protectKasSignSafeJson(build.txToSignSafeJson, build.signInputIndexes || [0]);
    const result = await protectKasHttpJson("POST", "/api/covenants/lowlevel-genesis/submit", {
      submit_intent: "submit_lowlevel_genesis_covenant_v1",
      submit_token: build.submit_token,
      signedSafeJson: signed.signedSafeJson,
      signed_safe_json_sha256: signed.signedSafeJsonSha256
    });
    const submit = result.body;
    if (UI.protectKasReleaseOutpoint && submit.submitted_txid) UI.protectKasReleaseOutpoint.value = `${submit.submitted_txid}:0`;
    if (UI.protectKasReleaseCovenantId && submit.covenant_id) UI.protectKasReleaseCovenantId.value = submit.covenant_id;
    setProtectKasStatus("Protected KAS transfer submitted. Inspect covenant UTXOs to verify blocked normal-send status.");
    setProtectKasProof({
      proof_kind: "cc_protect_kas_1d_sign_and_transfer_protected_kas_v1",
      build_ok: true,
      submit_http_status: result.http_status,
      submit_ok: submit.ok === true,
      submit_kind: submit.submit_kind,
      application_status: submit.application_status,
      submitted_txid: submit.submitted_txid,
      submitted_txid_matches_signed: submit.submitted_txid_matches_signed,
      destinationAddress: submit.destinationAddress,
      changeAddress: submit.changeAddress,
      amount_kas: submit.amount_kas,
      covenant_id: submit.covenant_id,
      post_submit_scan_status: submit.post_submit_scan && submit.post_submit_scan.status,
      normal_send_exclusion_expected: submit.post_submit_scan && submit.post_submit_scan.normal_send_exclusion_expected,
      signed_safe_json_sha256: signed.signedSafeJsonSha256,
      signatureScript_lengths: signed.after.map(function (item) { return item.signatureScript_length; }),
      private_key_printed: false,
      tx_to_sign_safe_json_printed: false,
      signed_transaction_json_printed: false,
      signature_script_printed: false,
      submit_token_printed: false,
      broadcasting: "submitted_once_to_testnet_or_active_wallet_network",
      minting: "none"
    });
    loadCovenantInspection();
  }

  function protectKasReleaseBuildProof(build, httpStatus) {
    return {
      proof_kind: "cc_protect_kas_1d_build_release_preview_v1",
      build_http_status: httpStatus,
      ok: build && build.ok === true,
      release_build_kind: build && build.release_build_kind,
      application_status: build && build.application_status,
      networkId: build && build.networkId,
      source_outpoint_key: build && build.source_outpoint_key,
      expected_covenant_id: build && build.expected_covenant_id,
      release_amount_kas: build && build.release_amount_kas,
      release_invariant: build && build.release_invariant,
      signInputIndexes: build && build.signInputIndexes,
      private_key_printed: false,
      tx_to_sign_safe_json_printed: false,
      signed_transaction_json_printed: false,
      signature_script_printed: false,
      submit_token_printed: false,
      broadcasting: "none",
      minting: "none"
    };
  }

  async function protectKasReleaseBuild() {
    protectKasSetSubmitEnabled(UI.protectKasReleaseSubmitButton, false);
    protectKasState.releaseBuild = null;
    const sourceOutpoint = readField(UI.protectKasReleaseOutpoint);
    const covenantId = readField(UI.protectKasReleaseCovenantId).toLowerCase();
    if (!sourceOutpoint) throw new Error("protect_kas_release_outpoint_required");
    if (!/^[0-9a-f]{64}$/i.test(covenantId)) throw new Error("protect_kas_release_covenant_id_required");
    const releaseMode = protectKasState.releaseMode === "programmable_kas_p2sh_owner_release" ? "programmable_kas_p2sh_owner_release" : "lowlevel_genesis";
    setProtectKasStatus("Building release transaction preview...");
    const result = releaseMode === "programmable_kas_p2sh_owner_release"
      ? await protectKasHttpJson("POST", "/api/covenants/programmable-kas/p2sh-owner-release/release/build", {
          source_outpoint: sourceOutpoint,
          expected_covenant_id: covenantId,
          fee_reserve_sompi: PROTECT_KAS_P2SH_OWNER_RELEASE_FEE_RESERVE_SOMPI
        })
      : await protectKasHttpJson("POST", "/api/covenants/lowlevel-genesis/release/build", {
          covenant_outpoint: sourceOutpoint,
          expected_covenant_id: covenantId
        });
    protectKasState.releaseBuild = result.body;
    protectKasSetSubmitEnabled(UI.protectKasReleaseSubmitButton, true);
    setProtectKasStatus(releaseMode === "programmable_kas_p2sh_owner_release"
      ? "P2SH Owner-Release build ready. Review proof, then sign and release KAS from this wallet."
      : "Release build ready. Review proof, then sign and release KAS.");
    const proof = protectKasReleaseBuildProof(result.body, result.http_status);
    proof.release_mode = releaseMode;
    setProtectKasProof(proof);
  }

  async function protectKasReleaseSubmit() {
    const build = protectKasState.releaseBuild;
    if (!build || !build.txToSignSafeJson) throw new Error("protect_kas_release_build_required_before_submit");
    const sourceOutpoint = readField(UI.protectKasReleaseOutpoint);
    const covenantId = readField(UI.protectKasReleaseCovenantId).toLowerCase();
    const releaseMode = protectKasState.releaseMode === "programmable_kas_p2sh_owner_release" ? "programmable_kas_p2sh_owner_release" : "lowlevel_genesis";
    setProtectKasStatus("Signing locally and releasing protected KAS...");
    protectKasSetSubmitEnabled(UI.protectKasReleaseSubmitButton, false);
    const signed = releaseMode === "programmable_kas_p2sh_owner_release"
      ? await protectKasSignP2shOwnerReleaseSafeJson(build.txToSignSafeJson, build.p2sh_owner_release_redeem_script_hex)
      : await protectKasSignSafeJson(build.txToSignSafeJson, build.signInputIndexes || [0]);
    const result = releaseMode === "programmable_kas_p2sh_owner_release"
      ? await protectKasHttpJson("POST", "/api/covenants/programmable-kas/p2sh-owner-release/release/submit", {
          submit_intent: "submit_programmable_kas_p2sh_owner_release_release_v1",
          submit_token: build.submit_token,
          signed_safe_json: signed.signedSafeJson,
          signed_safe_json_sha256: signed.signedSafeJsonSha256
        })
      : await protectKasHttpJson("POST", "/api/covenants/lowlevel-genesis/release/submit", {
          submit_intent: "submit_lowlevel_genesis_release_v1",
          covenant_outpoint: sourceOutpoint,
          expected_covenant_id: covenantId,
          signedSafeJson: signed.signedSafeJson,
          signed_safe_json_sha256: signed.signedSafeJsonSha256
        });
    const submit = result.body;
    setProtectKasStatus("Release submitted. Protected KAS should now be normal KAS in the active holder wallet.");
    setProtectKasProof({
      proof_kind: releaseMode === "programmable_kas_p2sh_owner_release" ? "cc_programmable_kas_1k_ui_sign_and_release_p2sh_owner_release_kas_v1" : "cc_protect_kas_1d_sign_and_release_kas_v1",
      release_mode: releaseMode,
      build_ok: true,
      submit_http_status: result.http_status,
      submit_ok: submit.ok === true,
      submit_kind: submit.submit_kind,
      application_status: submit.application_status,
      release_path_status: submit.release_path_status,
      submitted_txid: submit.submitted_txid,
      submitted_txid_matches_signed: submit.submitted_txid_matches_signed,
      source_outpoint_key: submit.source_outpoint_key || sourceOutpoint,
      expected_covenant_id: submit.expected_covenant_id || covenantId,
      release_amount_kas: submit.release_amount_kas,
      old_covenant_source_spent: submit.post_submit_scan && (submit.post_submit_scan.old_covenant_source_spent || submit.post_submit_scan.old_source_spent),
      release_output_native_kas: submit.post_submit_scan && submit.post_submit_scan.release_output_native_kas,
      release_output_normal_send_expected: submit.post_submit_scan && (submit.post_submit_scan.release_output_normal_send_expected || (submit.post_submit_scan.release_output && submit.post_submit_scan.release_output.normal_send_expected)),
      release_output_covenant_present: submit.post_submit_scan && submit.post_submit_scan.release_output ? submit.post_submit_scan.release_output.covenant_present === true : null,
      signed_safe_json_sha256: signed.signedSafeJsonSha256,
      signatureScript_lengths: signed.after.map(function (item) { return item.signatureScript_length; }),
      private_key_printed: false,
      tx_to_sign_safe_json_printed: false,
      signed_transaction_json_printed: false,
      signature_script_printed: false,
      submit_token_printed: false,
      broadcasting: "submitted_once_to_testnet_or_active_wallet_network",
      minting: "none"
    });
    protectKasState.releaseMode = "lowlevel_genesis";
    loadCovenantInspection();
  }

  function handleProtectKasAction(action) {
    action().catch(function (e) {
      const body = e && e.body ? e.body : null;
      const reason = body && (body.reason || body.error) ? String(body.reason || body.error) : String(e && e.message ? e.message : e);
      setProtectKasStatus(`blocked: ${reason}`);
      setProtectKasProof({
        proof_kind: "cc_protect_kas_1d_error_v1",
        ok: false,
        reason,
        http_status: e && e.http_status ? e.http_status : null,
        response_reason: body && body.reason ? body.reason : null,
        private_key_printed: false,
        tx_to_sign_safe_json_printed: false,
        signed_transaction_json_printed: false,
        signature_script_printed: false,
        submit_token_printed: false,
        broadcasting: "none",
        minting: "none"
      });
    });
  }


  const programmableKasAppBuildState = {};

  const PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI = "10000000";

  const PROGRAMMABLE_KAS_APP_CONFIGS = [
    {
      key: "owner_release",
      title: "P2SH Owner-Release KAS",
      statusId: "ccOwnerReleaseStatus",
      proofId: "ccOwnerReleaseProof",
      buildButtonId: "ccOwnerReleaseBuildButton",
      submitButtonId: "ccOwnerReleaseSubmitButton",
      releaseBuildButtonId: "ccOwnerReleaseBuildReleaseButton",
      releaseSubmitButtonId: "ccOwnerReleaseSubmitReleaseButton",
      buildRoute: "/api/covenants/programmable-kas/p2sh-owner-release/build",
      releaseBuildRoute: "/api/covenants/programmable-kas/p2sh-owner-release/release/build",
      amountId: "ccOwnerReleaseAmountKas",
      ownerAddressId: "ccOwnerReleaseOwnerAddress",
      sourceOutpointId: "ccOwnerReleaseSourceOutpoint",
      covenantIdId: "ccOwnerReleaseCovenantId",
      buildPayload: function () {
        const payload = {
          amount_sompi: kasToSompiText(readField($("ccOwnerReleaseAmountKas"))),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
        const owner = readField($("ccOwnerReleaseOwnerAddress"));
        if (owner) payload.owner_address = owner;
        return payload;
      },
      releasePayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccOwnerReleaseSourceOutpoint", "owner_release_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccOwnerReleaseCovenantId"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      }
    },
    {
      key: "absolute_time_lock",
      title: "Absolute Time Lock KAS",
      statusId: "ccAbsoluteTimeLockStatus",
      proofId: "ccAbsoluteTimeLockProof",
      buildButtonId: "ccAbsoluteTimeLockBuildButton",
      submitButtonId: "ccAbsoluteTimeLockSubmitButton",
      releaseBuildButtonId: "ccAbsoluteTimeLockBuildReleaseButton",
      releaseSubmitButtonId: "ccAbsoluteTimeLockSubmitReleaseButton",
      buildRoute: "/api/covenants/programmable-kas/p2sh-absolute-time-lock/build",
      releaseBuildRoute: "/api/covenants/programmable-kas/p2sh-absolute-time-lock/release/build",
      buildPayload: function () {
        return {
          amount_sompi: kasToSompiText(readField($("ccAbsoluteTimeLockAmountKas"))),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI,
          lock_daa_delta: requireProgrammableKasAppField("ccAbsoluteTimeLockDaaDelta", "absolute_time_lock_daa_delta_required")
        };
      },
      releasePayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccAbsoluteTimeLockSourceOutpoint", "absolute_time_lock_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccAbsoluteTimeLockCovenantId"),
          lock_target_daa: requireProgrammableKasAppField("ccAbsoluteTimeLockTargetDaa", "absolute_time_lock_target_daa_required"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      }
    },
    {
      key: "relative_sequence_lock",
      title: "Relative Sequence Lock KAS",
      statusId: "ccRelativeSequenceStatus",
      proofId: "ccRelativeSequenceProof",
      buildButtonId: "ccRelativeSequenceBuildButton",
      submitButtonId: "ccRelativeSequenceSubmitButton",
      releaseBuildButtonId: "ccRelativeSequenceBuildReleaseButton",
      releaseSubmitButtonId: "ccRelativeSequenceSubmitReleaseButton",
      buildRoute: "/api/covenants/programmable-kas/p2sh-relative-sequence-lock/build",
      releaseBuildRoute: "/api/covenants/programmable-kas/p2sh-relative-sequence-lock/release/build",
      buildPayload: function () {
        return {
          amount_sompi: kasToSompiText(readField($("ccRelativeSequenceAmountKas"))),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI,
          relative_daa_delta: requireProgrammableKasAppField("ccRelativeSequenceDaaDelta", "relative_sequence_daa_delta_required")
        };
      },
      releasePayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccRelativeSequenceSourceOutpoint", "relative_sequence_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccRelativeSequenceCovenantId"),
          relative_daa_delta: requireProgrammableKasAppField("ccRelativeSequenceDaaDelta", "relative_sequence_daa_delta_required"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      }
    },
    {
      key: "allowed_destination",
      title: "Allowed Destination KAS",
      statusId: "ccAllowedDestinationStatus",
      proofId: "ccAllowedDestinationProof",
      buildButtonId: "ccAllowedDestinationBuildButton",
      submitButtonId: "ccAllowedDestinationSubmitButton",
      releaseBuildButtonId: "ccAllowedDestinationBuildReleaseButton",
      releaseSubmitButtonId: "ccAllowedDestinationSubmitReleaseButton",
      buildRoute: "/api/covenants/programmable-kas/p2sh-allowed-destination/build",
      releaseBuildRoute: "/api/covenants/programmable-kas/p2sh-allowed-destination/release/build",
      buildPayload: function () {
        return {
          amount_sompi: kasToSompiText(readField($("ccAllowedDestinationAmountKas"))),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI,
          allowed_destination_address: requireProgrammableKasAppField("ccAllowedDestinationAddress", "allowed_destination_address_required")
        };
      },
      releasePayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccAllowedDestinationSourceOutpoint", "allowed_destination_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccAllowedDestinationCovenantId"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      }
    },
    {
      key: "immediate_recovery",
      title: "Immediate Recovery KAS",
      statusId: "ccImmediateRecoveryStatus",
      proofId: "ccImmediateRecoveryProof",
      buildButtonId: "ccImmediateRecoveryBuildButton",
      submitButtonId: "ccImmediateRecoverySubmitButton",
      releaseBuildButtonId: "ccImmediateRecoveryBuildReleaseButton",
      releaseSubmitButtonId: "ccImmediateRecoverySubmitReleaseButton",
      buildRoute: "/api/covenants/programmable-kas/p2sh-immediate-recovery/build",
      releaseBuildRoute: "/api/covenants/programmable-kas/p2sh-immediate-recovery/release/build",
      buildPayload: function () {
        const payload = {
          amount_sompi: kasToSompiText(readField($("ccImmediateRecoveryAmountKas"))),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI,
          recovery_address: requireProgrammableKasAppField("ccImmediateRecoveryAddress", "immediate_recovery_recovery_address_required")
        };
        const owner = readField($("ccImmediateRecoveryOwnerAddress"));
        if (owner) payload.owner_address = owner;
        return payload;
      },
      releasePayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccImmediateRecoverySourceOutpoint", "immediate_recovery_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccImmediateRecoveryCovenantId"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      }
    },
    {
      key: "escrow_refund",
      title: "Escrow / Refund KAS",
      statusId: "ccEscrowRefundStatus",
      proofId: "ccEscrowRefundProof",
      buildButtonId: "ccEscrowRefundBuildButton",
      submitButtonId: "ccEscrowRefundSubmitButton",
      releaseBuildButtonId: "ccEscrowSellerReleaseBuildButton",
      releaseSubmitButtonId: "ccEscrowSellerReleaseSubmitButton",
      refundBuildButtonId: "ccEscrowBuyerRefundBuildButton",
      refundSubmitButtonId: "ccEscrowBuyerRefundSubmitButton",
      buildRoute: "/api/covenants/programmable-kas/p2sh-escrow-refund/build",
      releaseBuildRoute: "/api/covenants/programmable-kas/p2sh-escrow-refund/release/build",
      refundBuildRoute: "/api/covenants/programmable-kas/p2sh-escrow-refund/refund/build",
      buildPayload: function () {
        return {
          amount_sompi: kasToSompiText(readField($("ccEscrowRefundAmountKas"))),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI,
          seller_release_address: requireProgrammableKasAppField("ccEscrowSellerAddress", "escrow_seller_release_address_required"),
          refund_lock_daa: requireProgrammableKasAppField("ccEscrowRefundLockDaa", "escrow_refund_lock_daa_required")
        };
      },
      releasePayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccEscrowRefundSourceOutpoint", "escrow_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccEscrowRefundCovenantId"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      },
      refundPayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccEscrowRefundSourceOutpoint", "escrow_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccEscrowRefundCovenantId"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      }
    },
    {
      key: "c5_time_lock_allowed_destination",
      title: "Time Lock + Allowed Destination KAS",
      statusId: "ccC5Status",
      proofId: "ccC5Proof",
      buildButtonId: "ccC5BuildButton",
      submitButtonId: "ccC5SubmitButton",
      releaseBuildButtonId: "ccC5BuildReleaseButton",
      releaseSubmitButtonId: "ccC5SubmitReleaseButton",
      buildRoute: "/api/covenants/programmable-kas/p2sh-absolute-time-lock-allowed-destination/build",
      releaseBuildRoute: "/api/covenants/programmable-kas/p2sh-absolute-time-lock-allowed-destination/release/build",
      buildPayload: function () {
        return {
          amount_sompi: kasToSompiText(readField($("ccC5AmountKas"))),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI,
          allowed_destination_address: requireProgrammableKasAppField("ccC5AllowedDestinationAddress", "c5_allowed_destination_address_required"),
          lock_daa_delta: requireProgrammableKasAppField("ccC5LockDaaDelta", "c5_lock_daa_delta_required")
        };
      },
      releasePayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccC5SourceOutpoint", "c5_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccC5CovenantId"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      }
    },
    {
      key: "c6_owner_release_delayed_recovery",
      title: "Owner Release + Delayed Recovery KAS",
      statusId: "ccC6Status",
      proofId: "ccC6Proof",
      buildButtonId: "ccC6BuildButton",
      submitButtonId: "ccC6SubmitButton",
      releaseBuildButtonId: "ccC6OwnerReleaseBuildButton",
      releaseSubmitButtonId: "ccC6OwnerReleaseSubmitButton",
      recoveryBuildButtonId: "ccC6RecoveryReleaseBuildButton",
      recoverySubmitButtonId: "ccC6RecoveryReleaseSubmitButton",
      buildRoute: "/api/covenants/programmable-kas/p2sh-owner-release-delayed-recovery/build",
      releaseBuildRoute: "/api/covenants/programmable-kas/p2sh-owner-release-delayed-recovery/release/build",
      recoveryBuildRoute: "/api/covenants/programmable-kas/p2sh-owner-release-delayed-recovery/recovery/build",
      buildPayload: function () {
        return {
          amount_sompi: kasToSompiText(readField($("ccC6AmountKas"))),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI,
          recovery_address: requireProgrammableKasAppField("ccC6RecoveryAddress", "c6_recovery_address_required"),
          recovery_lock_daa_delta: requireProgrammableKasAppField("ccC6RecoveryDaaDelta", "c6_recovery_daa_delta_required")
        };
      },
      releasePayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccC6SourceOutpoint", "c6_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccC6CovenantId"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      },
      recoveryPayload: function () {
        return {
          source_outpoint: requireProgrammableKasAppField("ccC6SourceOutpoint", "c6_source_outpoint_required"),
          expected_covenant_id: requireProgrammableKasAppCovenantId("ccC6CovenantId"),
          fee_reserve_sompi: PROGRAMMABLE_KAS_APP_DEFAULT_FEE_RESERVE_SOMPI
        };
      }
    }
  ];

  function requireProgrammableKasAppField(id, reason) {
    const value = readField($(id));
    if (!value) throw new Error(reason || `${id}_required`);
    return value;
  }

  function requireProgrammableKasAppCovenantId(id) {
    const value = readField($(id)).toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${id}_64_hex_required`);
    return value;
  }

  function programmableKasAppStatus(config, message) {
    setText($(config.statusId), message);
  }

  function programmableKasAppProof(config, packet) {
    const proofEl = $(config.proofId);
    if (!proofEl) return;
    proofEl.classList.remove("hidden");
    setText(proofEl, JSON.stringify(packet, null, 2));
  }

  function programmableKasAppSubmitButtonId(config, mode) {
    if (mode === "release") return config.releaseSubmitButtonId;
    if (mode === "refund") return config.refundSubmitButtonId;
    if (mode === "recovery") return config.recoverySubmitButtonId;
    return config.submitButtonId;
  }

  function programmableKasAppStateKey(mode) {
    if (mode === "release") return "releaseBuild";
    if (mode === "refund") return "refundBuild";
    if (mode === "recovery") return "recoveryBuild";
    return "build";
  }

  function programmableKasAppSignedStateKey(mode) {
    if (mode === "release") return "releaseSigned";
    if (mode === "refund") return "refundSigned";
    if (mode === "recovery") return "recoverySigned";
    return "signed";
  }

  function programmableKasAppDisableSubmit(config, mode) {
    const ids = [];
    if (!mode || mode === "lock" || mode === "build") ids.push(config.submitButtonId);
    if (!mode || mode === "release") ids.push(config.releaseSubmitButtonId);
    if (!mode || mode === "refund") ids.push(config.refundSubmitButtonId);
    if (!mode || mode === "recovery") ids.push(config.recoverySubmitButtonId);
    ids.forEach(function (id) {
      const button = $(id);
      if (button) button.disabled = true;
    });
  }

  function programmableKasAppEnableSubmit(config, mode, enabled) {
    const id = programmableKasAppSubmitButtonId(config, mode);
    const button = $(id);
    if (button) button.disabled = !enabled;
  }

  function programmableKasAppCanSignAndSubmit(body) {
    return !!(body && body.txToSignSafeJson && body.submit_route && body.submit_token);
  }

  function programmableKasAppFindRedeemScriptHex(body) {
    if (!body || typeof body !== "object") return "";
    if (typeof body.redeem_script_hex === "string" && body.redeem_script_hex) return body.redeem_script_hex;
    const key = Object.keys(body).find(function (name) { return /_redeem_script_hex$/.test(name) && typeof body[name] === "string" && body[name]; });
    return key ? String(body[key]) : "";
  }

  function programmableKasAppCanRecomputeC5RedeemScript(config, body) {
    return !!(config && config.key === "c5_time_lock_allowed_destination" && body && typeof body === "object" &&
      body.release_signing_model && body.release_signing_model.redeem_script_recompute_required_from_public_fields === true &&
      String(body.owner_address || "").trim() &&
      String(body.allowed_destination_address || "").trim() &&
      /^[0-9]+$/.test(String(body.lock_target_daa || body.release_lockTime || "").trim()));
  }

  function programmableKasAppCanRecomputeC6RedeemScript(config, body) {
    return !!(config && config.key === "c6_owner_release_delayed_recovery" && body && typeof body === "object" &&
      String(body.owner_address || "").trim() &&
      String(body.recovery_address || "").trim() &&
      /^[0-9]+$/.test(String(body.recovery_lock_target_daa || body.release_lockTime || "").trim()) &&
      String(body.p2sh_owner_release_delayed_recovery_redeem_script_sha256 || "").trim());
  }

  function programmableKasAppCanResolveRedeemScriptHex(config, body) {
    return !!programmableKasAppFindRedeemScriptHex(body) ||
      programmableKasAppCanRecomputeC5RedeemScript(config, body) ||
      programmableKasAppCanRecomputeC6RedeemScript(config, body);
  }

  function programmableKasAppScriptPublicKeyOutputBytesHex(spk) {
    const json = spk && typeof spk.toJSON === "function" ? spk.toJSON() : null;
    const versionRaw = json && json.version != null ? json.version : spk && spk.version != null ? spk.version : 0;
    const scriptRaw = json && json.script != null ? json.script : spk && spk.script != null ? spk.script : null;
    const scriptHex = scriptPreviewValue(scriptRaw);
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 0 || version > 65535) throw new Error("c5_script_public_key_version_invalid");
    if (!scriptHex || !/^[0-9a-f]+$/i.test(scriptHex) || scriptHex.length % 2 !== 0) throw new Error("c5_script_public_key_script_hex_invalid");
    return version.toString(16).padStart(4, "0") + scriptHex.toLowerCase();
  }

  async function programmableKasAppRecomputeC5RedeemScriptHex(body) {
    const sdk = await protectKasSdk();
    if (!sdk.Address || !sdk.XOnlyPublicKey || !sdk.payToAddressScript || !sdk.ScriptBuilder || !sdk.Opcodes) throw new Error("c5_redeem_script_sdk_surface_missing");
    if (typeof sdk.XOnlyPublicKey.fromAddress !== "function") throw new Error("c5_xonly_public_key_from_address_missing");

    const ownerAddress = String(body && body.owner_address || "").trim();
    const allowedDestinationAddress = String(body && body.allowed_destination_address || "").trim();
    const lockTargetDaaText = String(body && (body.lock_target_daa || body.release_lockTime) || "").trim();
    if (!ownerAddress) throw new Error("c5_owner_address_missing_for_redeem_script_recompute");
    if (!allowedDestinationAddress) throw new Error("c5_allowed_destination_missing_for_redeem_script_recompute");
    if (!/^[0-9]+$/.test(lockTargetDaaText)) throw new Error("c5_lock_target_daa_missing_for_redeem_script_recompute");

    const ownerXOnlyPublicKeyHex = sdk.XOnlyPublicKey.fromAddress(new sdk.Address(ownerAddress)).toString();
    if (!/^[0-9a-f]{64}$/i.test(ownerXOnlyPublicKeyHex)) throw new Error("c5_owner_xonly_public_key_invalid");

    const allowedDestinationSpk = sdk.payToAddressScript(new sdk.Address(allowedDestinationAddress));
    const allowedDestinationSpkBytesHex = programmableKasAppScriptPublicKeyOutputBytesHex(allowedDestinationSpk);
    const builder = new sdk.ScriptBuilder({ flags: { covenantsEnabled: true } });
    if (typeof builder.addI64 !== "function") throw new Error("c5_script_builder_addI64_missing");

    const scriptHex = builder
      .addLockTime(BigInt(lockTargetDaaText))
      .addOp(sdk.Opcodes.OpCheckLockTimeVerify)
      .addOp(sdk.Opcodes.OpTxOutputCount)
      .addI64(1n)
      .addOp(sdk.Opcodes.OpEqualVerify)
      .addI64(0n)
      .addOp(sdk.Opcodes.OpTxOutputSpk)
      .addData(allowedDestinationSpkBytesHex)
      .addOp(sdk.Opcodes.OpEqualVerify)
      .addData(ownerXOnlyPublicKeyHex)
      .addOp(sdk.Opcodes.OpCheckSig)
      .drain();

    const expectedHash = String(body && body.p2sh_absolute_time_lock_allowed_destination_redeem_script_sha256 || "").trim().toLowerCase();
    if (expectedHash) {
      const actualHash = await sha256Text(scriptHex);
      if (actualHash !== expectedHash) throw new Error("c5_recomputed_redeem_script_sha256_mismatch");
    }
    return scriptHex;
  }

  async function programmableKasAppRecomputeC6RedeemScriptHex(body) {
    const sdk = await protectKasSdk();
    if (!sdk.Address || !sdk.XOnlyPublicKey || !sdk.ScriptBuilder || !sdk.Opcodes) throw new Error("c6_redeem_script_sdk_surface_missing");
    if (typeof sdk.XOnlyPublicKey.fromAddress !== "function") throw new Error("c6_xonly_public_key_from_address_missing");

    const ownerAddress = String(body && body.owner_address || "").trim();
    const recoveryAddress = String(body && body.recovery_address || "").trim();
    const recoveryLockTargetDaaText = String(body && (body.recovery_lock_target_daa || body.release_lockTime) || "").trim();
    if (!ownerAddress) throw new Error("c6_owner_address_missing_for_redeem_script_recompute");
    if (!recoveryAddress) throw new Error("c6_recovery_address_missing_for_redeem_script_recompute");
    if (!/^[0-9]+$/.test(recoveryLockTargetDaaText)) throw new Error("c6_recovery_lock_target_daa_missing_for_redeem_script_recompute");

    const ownerXOnlyPublicKeyHex = sdk.XOnlyPublicKey.fromAddress(new sdk.Address(ownerAddress)).toString();
    const recoveryXOnlyPublicKeyHex = sdk.XOnlyPublicKey.fromAddress(new sdk.Address(recoveryAddress)).toString();
    if (!/^[0-9a-f]{64}$/i.test(ownerXOnlyPublicKeyHex)) throw new Error("c6_owner_xonly_public_key_invalid");
    if (!/^[0-9a-f]{64}$/i.test(recoveryXOnlyPublicKeyHex)) throw new Error("c6_recovery_xonly_public_key_invalid");

    const builder = new sdk.ScriptBuilder({ flags: { covenantsEnabled: true } });
    const scriptHex = builder
      .addOp(sdk.Opcodes.OpDup)
      .addData(ownerXOnlyPublicKeyHex)
      .addOp(sdk.Opcodes.OpCheckSig)
      .addOp(sdk.Opcodes.OpIf)
      .addOp(sdk.Opcodes.OpDrop)
      .addOp(sdk.Opcodes.OpTrue)
      .addOp(sdk.Opcodes.OpElse)
      .addLockTime(BigInt(recoveryLockTargetDaaText))
      .addOp(sdk.Opcodes.OpCheckLockTimeVerify)
      .addData(recoveryXOnlyPublicKeyHex)
      .addOp(sdk.Opcodes.OpCheckSig)
      .addOp(sdk.Opcodes.OpEndIf)
      .drain();

    const expectedHash = String(body && body.p2sh_owner_release_delayed_recovery_redeem_script_sha256 || "").trim().toLowerCase();
    if (expectedHash) {
      const actualHash = await sha256Text(scriptHex);
      if (actualHash !== expectedHash) throw new Error("c6_recomputed_redeem_script_sha256_mismatch");
    }
    return scriptHex;
  }

  async function programmableKasAppResolveRedeemScriptHex(config, body) {
    const direct = programmableKasAppFindRedeemScriptHex(body);
    if (direct) return direct;
    if (programmableKasAppCanRecomputeC5RedeemScript(config, body)) return programmableKasAppRecomputeC5RedeemScriptHex(body);
    if (programmableKasAppCanRecomputeC6RedeemScript(config, body)) return programmableKasAppRecomputeC6RedeemScriptHex(body);
    return "";
  }

  function programmableKasAppBuildProof(config, body, httpStatus, mode) {
    return {
      proof_kind: `ui_app_wiring_a_${config.key}_${mode || "build"}_preview_v1`,
      app_key: config.key,
      app_title: config.title,
      mode: mode || "build",
      http_status: httpStatus,
      ok: body && body.ok === true,
      build_kind: body && (body.build_kind || body.release_build_kind || body.refund_build_kind),
      application_status: body && body.application_status,
      proof_stage: body && body.proof_stage,
      networkId: body && body.networkId,
      amount_kas: body && body.amount_kas,
      source_outpoint_key: body && body.source_outpoint_key,
      expected_covenant_id: body && body.expected_covenant_id,
      covenant_id: body && body.covenant_id,
      submit_route_enabled: !!(body && body.submit_route),
      submit_token_present: !!(body && body.submit_token),
      tx_to_sign_safe_json_present: !!(body && body.txToSignSafeJson),
      signInputIndexes: body && body.signInputIndexes,
      private_key_printed: false,
      tx_to_sign_safe_json_printed: false,
      signed_transaction_json_printed: false,
      signature_script_printed: false,
      redeem_script_printed: false,
      submit_token_printed: false,
      signing: "none",
      broadcasting: "none",
      minting: "none",
      wallet_mutation: "none"
    };
  }

  async function programmableKasAppBuild(config) {
    programmableKasAppDisableSubmit(config, "lock");
    programmableKasAppStatus(config, `Building ${config.title} preview...`);
    const result = await protectKasHttpJson("POST", config.buildRoute, config.buildPayload());
    programmableKasAppBuildState[config.key] = Object.assign({}, programmableKasAppBuildState[config.key] || {}, { build: result.body });
    const canSubmit = programmableKasAppCanSignAndSubmit(result.body);
    programmableKasAppEnableSubmit(config, "build", canSubmit);
    programmableKasAppStatus(config, canSubmit ? `${config.title} build preview ready. Sign and submit is enabled.` : `${config.title} build preview ready. Submit token or signing payload missing; sign and submit remains disabled.`);
    programmableKasAppProof(config, programmableKasAppBuildProof(config, result.body, result.http_status, "build"));
  }

  async function programmableKasAppReleaseBuild(config, mode) {
    const buildRoute = mode === "refund" ? config.refundBuildRoute : mode === "recovery" ? config.recoveryBuildRoute : config.releaseBuildRoute;
    const payloadFactory = mode === "refund" ? config.refundPayload : mode === "recovery" ? config.recoveryPayload : config.releasePayload;
    if (!buildRoute || typeof payloadFactory !== "function") throw new Error(`${config.key}_${mode || "release"}_build_not_configured`);
    programmableKasAppDisableSubmit(config, mode || "release");
    programmableKasAppStatus(config, `Building ${config.title} ${mode || "release"} preview...`);
    const result = await protectKasHttpJson("POST", buildRoute, payloadFactory());
    const state = Object.assign({}, programmableKasAppBuildState[config.key] || {});
    state[programmableKasAppStateKey(mode || "release")] = result.body;
    programmableKasAppBuildState[config.key] = state;
    const canSubmit = programmableKasAppCanSignAndSubmit(result.body) && programmableKasAppCanResolveRedeemScriptHex(config, result.body);
    programmableKasAppEnableSubmit(config, mode || "release", canSubmit);
    programmableKasAppStatus(config, canSubmit ? `${config.title} ${mode || "release"} build preview ready. Sign and submit is enabled.` : `${config.title} ${mode || "release"} build preview ready. Redeem script, submit token, or signing payload missing; sign and submit remains disabled.`);
    programmableKasAppProof(config, programmableKasAppBuildProof(config, result.body, result.http_status, mode || "release"));
  }

  async function programmableKasAppSignBuildBody(config, mode, body) {
    if (!body || !body.txToSignSafeJson) throw new Error(`${config.key}_${mode}_tx_to_sign_safe_json_missing`);
    const normalizedMode = mode || "build";
    if (normalizedMode === "build") {
      return Object.assign({ signing_mode: "native_funding_input_createInputSignature" }, await protectKasSignSafeJson(body.txToSignSafeJson, body.signInputIndexes));
    }
    const redeemScriptHex = await programmableKasAppResolveRedeemScriptHex(config, body);
    if (!redeemScriptHex) throw new Error(`${config.key}_${normalizedMode}_redeem_script_hex_missing`);
    const indexes = asArray(body.signInputIndexes).map(function (value) { return Number(value); }).filter(function (value) { return Number.isInteger(value) && value >= 0; });
    if (indexes.length && (indexes.length !== 1 || indexes[0] !== 0)) throw new Error(`${config.key}_${normalizedMode}_unsupported_p2sh_sign_input_indexes`);
    return Object.assign({ signing_mode: "p2sh_redeem_script_signatureScript" }, await protectKasSignP2shOwnerReleaseSafeJson(body.txToSignSafeJson, redeemScriptHex));
  }

  function programmableKasAppSignSubmitProof(config, mode, buildBody, signed, submitResult) {
    const body = submitResult && submitResult.body ? submitResult.body : {};
    return {
      proof_kind: `ui_app_wiring_c_${config.key}_${mode || "build"}_sign_submit_v1`,
      app_key: config.key,
      app_title: config.title,
      mode: mode || "build",
      signing_mode: signed && signed.signing_mode,
      signed_safe_json_sha256: signed && signed.signedSafeJsonSha256,
      signatureScript_before: signed && signed.before,
      signatureScript_after: signed && signed.after,
      submit_http_status: submitResult && submitResult.http_status,
      submit_ok: body && body.ok === true,
      submit_kind: body && body.submit_kind,
      application_status: body && body.application_status,
      release_path_status: body && body.release_path_status,
      submitted_txid: body && body.submitted_txid,
      source_outpoint_key: body && (body.source_outpoint_key || (body.tracking && body.tracking.source_outpoint_key)),
      covenant_id: body && (body.covenant_id || (body.tracking && body.tracking.covenant_id)),
      released_output_outpoint: body && (body.released_output_outpoint || (body.tracking && body.tracking.released_output_outpoint)),
      tracking_record_status: body && body.tracking && (body.tracking.record_status || body.tracking.status),
      private_key_printed: false,
      tx_to_sign_safe_json_printed: false,
      signed_transaction_json_printed: false,
      signature_script_printed: false,
      redeem_script_printed: false,
      submit_token_printed: false,
      signed_transaction_json_echoed: body && body.signed_transaction_json_echoed === true ? true : false,
      signature_script_echoed: body && body.signature_script_echoed === true ? true : false,
      redeem_script_echoed: body && body.redeem_script_echoed === true ? true : false,
      submit_token_echoed: body && body.submit_token_echoed === true ? true : false,
      broadcasting: body && body.broadcasting ? body.broadcasting : "submitted_once_to_testnet_10_or_route_defined_network",
      minting: body && body.minting ? body.minting : "none",
      wallet_mutation: body && body.wallet_mutation ? body.wallet_mutation : "route_controlled_after_accepted_submit"
    };
  }

  async function programmableKasAppSignAndSubmit(config, mode) {
    const normalizedMode = mode || "build";
    const state = Object.assign({}, programmableKasAppBuildState[config.key] || {});
    const buildBody = state[programmableKasAppStateKey(normalizedMode)];
    if (!buildBody) throw new Error(`${config.key}_${normalizedMode}_build_preview_required_before_sign_submit`);
    if (!buildBody.submit_route || !buildBody.submit_token) throw new Error(`${config.key}_${normalizedMode}_submit_route_or_token_missing`);
    programmableKasAppEnableSubmit(config, normalizedMode, false);
    programmableKasAppStatus(config, `Signing ${config.title} ${normalizedMode} transaction locally...`);
    const signed = await programmableKasAppSignBuildBody(config, normalizedMode, buildBody);
    state[programmableKasAppSignedStateKey(normalizedMode)] = { signedSafeJsonSha256: signed.signedSafeJsonSha256 };
    programmableKasAppBuildState[config.key] = state;
    programmableKasAppStatus(config, `Submitting ${config.title} ${normalizedMode} transaction...`);
    const submitResult = await protectKasHttpJson("POST", buildBody.submit_route, {
      submit_token: buildBody.submit_token,
      submit_intent: buildBody.submit_intent_required || buildBody.submit_intent || undefined,
      signed_safe_json: signed.signedSafeJson
    });
    programmableKasAppStatus(config, `${config.title} ${normalizedMode} submitted.`);
    programmableKasAppProof(config, programmableKasAppSignSubmitProof(config, normalizedMode, buildBody, signed, submitResult));
  }

  function handleProgrammableKasAppAction(config, action) {
    action().catch(function (e) {
      const body = e && e.body ? e.body : null;
      const reason = body && (body.reason || body.error) ? String(body.reason || body.error) : String(e && e.message ? e.message : e);
      programmableKasAppStatus(config, `blocked: ${reason}`);
      programmableKasAppProof(config, {
        proof_kind: `ui_app_wiring_a_${config.key}_error_v1`,
        app_key: config.key,
        ok: false,
        reason,
        http_status: e && e.http_status ? e.http_status : null,
        response_reason: body && body.reason ? body.reason : null,
        private_key_printed: false,
        tx_to_sign_safe_json_printed: false,
        signed_transaction_json_printed: false,
        signature_script_printed: false,
        redeem_script_printed: false,
        submit_token_printed: false,
        signing: "none",
        broadcasting: "none",
        minting: "none",
        wallet_mutation: "none"
      });
    });
  }

  function initProgrammableKasAppBuildOnlyWiring() {
    PROGRAMMABLE_KAS_APP_CONFIGS.forEach(function (config) {
      programmableKasAppDisableSubmit(config);
      const buildButton = $(config.buildButtonId);
      const submitButton = $(config.submitButtonId);
      const releaseBuildButton = $(config.releaseBuildButtonId);
      const releaseSubmitButton = $(config.releaseSubmitButtonId);
      const refundBuildButton = $(config.refundBuildButtonId);
      const refundSubmitButton = $(config.refundSubmitButtonId);
      const recoveryBuildButton = $(config.recoveryBuildButtonId);
      const recoverySubmitButton = $(config.recoverySubmitButtonId);
      if (buildButton) buildButton.addEventListener("click", function () { handleProgrammableKasAppAction(config, function () { return programmableKasAppBuild(config); }); });
      if (submitButton) submitButton.addEventListener("click", function () { handleProgrammableKasAppAction(config, function () { return programmableKasAppSignAndSubmit(config, "build"); }); });
      if (releaseBuildButton) releaseBuildButton.addEventListener("click", function () { handleProgrammableKasAppAction(config, function () { return programmableKasAppReleaseBuild(config, "release"); }); });
      if (releaseSubmitButton) releaseSubmitButton.addEventListener("click", function () { handleProgrammableKasAppAction(config, function () { return programmableKasAppSignAndSubmit(config, "release"); }); });
      if (refundBuildButton) refundBuildButton.addEventListener("click", function () { handleProgrammableKasAppAction(config, function () { return programmableKasAppReleaseBuild(config, "refund"); }); });
      if (refundSubmitButton) refundSubmitButton.addEventListener("click", function () { handleProgrammableKasAppAction(config, function () { return programmableKasAppSignAndSubmit(config, "refund"); }); });
      if (recoveryBuildButton) recoveryBuildButton.addEventListener("click", function () { handleProgrammableKasAppAction(config, function () { return programmableKasAppReleaseBuild(config, "recovery"); }); });
      if (recoverySubmitButton) recoverySubmitButton.addEventListener("click", function () { handleProgrammableKasAppAction(config, function () { return programmableKasAppSignAndSubmit(config, "recovery"); }); });
    });
  }

  async function buildPreviewPacket() {
    const sdkReport = await loadToccataSdk();
    if (!templateRegistryState.loaded) {
      await loadTemplateRegistry();
    }
    const profile = contractProfile(readField(UI.contractType));
    const registry = templateRegistryState.data;
    const selectedNetwork = readField(UI.network);
    const selectedTemplateNetworks = asArray(profile.network_support);
    const registryNetworkSupport = registry && registry.network_policy
      ? asArray(registry.network_policy.registry_network_support)
      : [];
    const networkSupportedByRegistry = selectedNetwork
      ? registryNetworkSupport.includes(selectedNetwork)
      : false;
    const networkSupportedByTemplate = selectedNetwork && selectedTemplateNetworks.length
      ? selectedTemplateNetworks.includes(selectedNetwork)
      : false;
    const registryHash = registry ? await sha256Text(stableJson(registry)) : null;
    const formInputs = {
      contract_type: readField(UI.contractType),
      network: selectedNetwork,
      owner_mode: readField(UI.ownerMode),
      owner_identifier: readField(UI.ownerIdentifier) || null,
      initial_kas_amount: readField(UI.initialKas) || null,
      display_name: readField(UI.displayName) || null
    };
    const profileSpecificInputs = readProfileSpecificInputs(formInputs.contract_type);
    const profileSpecificValidation = validateProfileSpecificInputs(formInputs.contract_type, profileSpecificInputs);
    const selectedTemplate = profile.template_id ? {
      template_id: profile.template_id,
      template_version: profile.template_version || null,
      template_name: profile.label,
      contract_type: profile.contract_type || null,
      proof_status: profile.proof_status || null,
      warning_class: profile.warning_class || null,
      network_support: selectedTemplateNetworks,
      live_action_enabled: profile.live_action_enabled === true,
      signing_enabled: profile.signing_enabled === true,
      broadcasting_enabled: profile.broadcasting_enabled === true,
      minting_enabled: profile.minting_enabled === true
    } : null;
    const profileTransitionPreview = await buildProfileTransitionPreview(formInputs.contract_type, profileSpecificInputs, profileSpecificValidation, selectedTemplate);
    const proofBasis = {
      registry_hash_sha256: registryHash,
      form_inputs: formInputs,
      profile_specific_inputs: profileSpecificInputs,
      profile_specific_validation: profileSpecificValidation,
      profile_transition_preview: profileTransitionPreview,
      token_standard_preview: formInputs.contract_type === "issuer_l1_token" ? { standard_id: "oma_l1_covenant_token_profile_v0_1", token_state_schema: "oma_l1_token_state_v1", controller_state_schema: "oma_l1_token_controller_state_v1", canonical_token_id_source: "asset_covenant_id" } : null,
      selected_template: selectedTemplate,
      sdk_version: sdkReport && sdkReport.version ? sdkReport.version : "unknown"
    };
    const proofBasisHash = await sha256Text(stableJson(proofBasis));
    const liveActionBlockers = [
      "signing_disabled_until_local_mac_signing_proof",
      "broadcasting_disabled_until_local_mac_broadcast_proof",
      "minting_disabled_until_local_mac_mint_or_live_action_proof",
      "sdk_upgrade_or_approved_production_bridge_required_before_deployment",
      "aws_deployment_blocked_until_mac_live_action_tests_pass"
    ];
    if (!networkSupportedByRegistry) liveActionBlockers.push("selected_network_not_supported_by_registry");
    if (!networkSupportedByTemplate) liveActionBlockers.push("selected_network_not_supported_by_template");
    if (profileSpecificValidation.validation_status !== "preview_inputs_captured") liveActionBlockers.push("profile_specific_required_fields_missing");
    if (profileSpecificValidation.live_action_ready !== true) liveActionBlockers.push("profile_specific_live_action_not_ready");

    const packet = {
      packet_kind: "oma_covenant_controls_preview_v1",
      proof_packet_kind: "oma_covenant_controls_proof_packet_v1",
      proof_packet_status: "preview_only_not_signable",
      application_status: "preview_only",
      execution_enabled: false,
      mutation_enabled: false,
      signing_enabled: false,
      broadcasting_enabled: false,
      minting_enabled: false,
      packet_export_status: "human_readable_json_preview",
      registry_hash_sha256: registryHash,
      proof_basis_hash_sha256: proofBasisHash,
      sdk_bridge: sdkReport,
      template_registry: registry ? {
        registry_kind: registry.registry_kind,
        registry_version: registry.registry_version,
        registry_status: registry.registry_status,
        registry_hash_sha256: registryHash,
        network_support: registryNetworkSupport,
        not_tn10_gated: registry.network_policy && registry.network_policy.not_tn10_gated,
        safety_state: registry.safety_state
      } : {
        loaded: false,
        error: templateRegistryState.error || "not_loaded"
      },
      network_guard: {
        selected_network: selectedNetwork,
        not_tn10_gated: registry && registry.network_policy ? registry.network_policy.not_tn10_gated === true : false,
        network_supported_by_registry: networkSupportedByRegistry,
        network_supported_by_template: networkSupportedByTemplate,
        mainnet_preview_allowed: selectedNetwork === "mainnet" && networkSupportedByRegistry && networkSupportedByTemplate,
        live_mainnet_action_enabled: false,
        live_testnet_action_enabled: false
      },
      requested_profile: {
        contract_type: formInputs.contract_type,
        label: profile.label,
        template_id: profile.template_id || null,
        template_version: profile.template_version || null,
        template_contract_type: profile.contract_type || null,
        proof_status: profile.proof_status || null,
        warning_class: profile.warning_class || null,
        network_support: selectedTemplateNetworks,
        live_action_enabled: profile.live_action_enabled === true,
        network: formInputs.network,
        owner_mode: formInputs.owner_mode,
        owner_identifier: formInputs.owner_identifier,
        initial_kas_amount: formInputs.initial_kas_amount,
        display_name: formInputs.display_name,
        profile_specific_inputs: profileSpecificInputs,
        profile_specific_validation: profileSpecificValidation
      },
      profile_specific_inputs: profileSpecificInputs,
      profile_specific_validation: profileSpecificValidation,
      profile_transition_preview: profileTransitionPreview,
      token_standard_preview: formInputs.contract_type === "issuer_l1_token" ? { standard_id: "oma_l1_covenant_token_profile_v0_1", token_state_schema: "oma_l1_token_state_v1", controller_state_schema: "oma_l1_token_controller_state_v1", canonical_token_id_source: "asset_covenant_id" } : null,
      selected_template: selectedTemplate,
      classification_preview: {
        native_kas_without_covenant: "normal KAS",
        covenant_id_present_unknown_template: "unknown covenanted KAS; normal-send disabled",
        recognized_profile: profile.classification_target,
        selected_template_token: selectedTemplate ? (profile.classification_target === "oma_l1_covenant_token_state" || selectedTemplate.contract_type === "l1_covenant_token" || selectedTemplate.contract_type === "regulated_asset_token") : false
      },
      proof_surfaces_before_signing: [
        "template id, name, version, and proof status",
        "registry hash and selected template support",
        "profile-specific issuer, controller, token, or regulated-asset inputs",
        "profile-specific output, state, and role transition preview",
        "network guard and mainnet/testnet live-action lock",
        "input UTXO plan and covenant-bearing input warning",
        "output plan with covenant bindings",
        "state schema before/after preview",
        "scriptPublicKey token/controller state envelope encode/decode proof",
        "controller state before/after preview",
        "supply delta / burn delta / freeze-seize state when applicable",
        "required roles and signatures",
        "compute budget, storage mass, and fee estimate",
        "normal-send exclusion proof",
        "post-submit scan proof"
      ],
      builder_plan_preview: {
        builder_status: "not_built_yet",
        profile_inputs_status: "captured_for_preview_packet_only",
        profile_validation_status: profileSpecificValidation.validation_status,
        input_plan_status: "profile_transition_preview_only_offline_builder_pending",
        output_plan_status: "profile_transition_preview_only_offline_builder_pending",
        state_schema_status: "profile_transition_preview_only_template_builder_pending",
        role_requirements_status: "profile_transition_preview_only",
        admin_actions_status: "profile_transition_preview_only",
        compute_storage_fee_status: "not_estimated_until_builder",
        post_submit_scan_status: "required_before_live_action"
      },
      required_proofs_before_live_action: profile.required_proofs,
      validation_blockers_before_live_action: profileSpecificValidation.validation_blockers_before_live_action,
      safety_gates: [
        "normal-send covenant UTXO exclusion",
        "recognized template hash",
        "state schema decode",
        "output plan review",
        "compute budget and storage mass proof",
        "local Mac signing proof",
        "local Mac broadcast proof",
        "local Mac mint or approved live action proof",
        "post-submit scan proof"
      ],
      live_action_blockers: liveActionBlockers,
      next_steps: [
        "review profile-specific validation warnings",
        "review profile-specific proof inputs",
        "review profile-specific output/state/role transition preview",
        "prove OMA L1 token state envelope in scriptPublicKey preview",
        "build OMA L1 token deploy-genesis builder proof packet",
        "prove issue/mint and transfer transitions before product-ready token label",
        "prove selected template output plan without signing",
        "prove SDK upgrade or approved production bridge architecture",
        "only then perform local Mac signing/broadcast/mint proof before AWS"
      ]
    };

    setText(UI.previewPacket, JSON.stringify(packet, null, 2));
    ensureProofPacketExportPanel();
    setProofPacketExportStatus("ready: preview-only proof packet available for copy/download");
  }


  function ensureProofPacketExportPanel() {
    const existing = $("ccProofPacketExportPanel");
    if (existing) {
      UI.proofPacketExportPanel = existing;
      UI.proofPacketExportStatus = $("ccProofPacketExportStatus");
      UI.proofPacketCopy = $("ccCopyProofPacket");
      UI.proofPacketDownload = $("ccDownloadProofPacket");
      return existing;
    }

    const article = findPreviewBuilderArticle();
    if (!article || !UI.previewPacket || !UI.previewPacket.parentNode) return null;

    const panel = document.createElement("div");
    panel.id = "ccProofPacketExportPanel";
    panel.className = "cc-preview-box";
    panel.style.marginTop = "1rem";
    panel.innerHTML = `
      <strong>Proof packet export</strong><br>
      <span class="muted">Copy or download the current preview-only proof packet. This does not sign, broadcast, mint, or mutate wallet state.</span>
      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:0.75rem;">
        <button id="ccCopyProofPacket" type="button" class="secondary">Copy proof packet</button>
        <button id="ccDownloadProofPacket" type="button" class="secondary">Download proof packet JSON</button>
      </div>
      <p id="ccProofPacketExportStatus" class="muted">Status: build a proof packet first.</p>
    `;

    UI.previewPacket.parentNode.insertBefore(panel, UI.previewPacket.nextSibling);

    UI.proofPacketExportPanel = panel;
    UI.proofPacketExportStatus = $("ccProofPacketExportStatus");
    UI.proofPacketCopy = $("ccCopyProofPacket");
    UI.proofPacketDownload = $("ccDownloadProofPacket");
    return panel;
  }

  function currentProofPacketExport() {
    const text = String(UI.previewPacket && UI.previewPacket.textContent ? UI.previewPacket.textContent : "").trim();
    if (!text) {
      return { ok: false, reason: "proof_packet_empty", text: "", packet: null };
    }
    try {
      const packet = JSON.parse(text);
      if (!packet || packet.proof_packet_kind !== "oma_covenant_controls_proof_packet_v1") {
        return { ok: false, reason: "build_preview_packet_required", text, packet };
      }
      if (packet.signing_enabled !== false || packet.broadcasting_enabled !== false || packet.minting_enabled !== false) {
        return { ok: false, reason: "proof_packet_safety_flags_not_disabled", text, packet };
      }
      return { ok: true, reason: "ready", text: JSON.stringify(packet, null, 2), packet };
    } catch (e) {
      return { ok: false, reason: "proof_packet_json_invalid", text, packet: null };
    }
  }

  function setProofPacketExportStatus(message) {
    setText(UI.proofPacketExportStatus, `Status: ${message}`);
  }

  async function copyProofPacket() {
    ensureProofPacketExportPanel();
    const result = currentProofPacketExport();
    if (!result.ok) {
      setProofPacketExportStatus(`blocked: ${result.reason}`);
      return result;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      setProofPacketExportStatus("blocked: clipboard API unavailable");
      return { ok: false, reason: "clipboard_unavailable" };
    }
    await navigator.clipboard.writeText(result.text);
    setProofPacketExportStatus("copied preview-only proof packet; signing/broadcasting/minting remain disabled");
    return { ok: true, action: "copy", packet_kind: result.packet.proof_packet_kind };
  }

  function downloadProofPacket() {
    ensureProofPacketExportPanel();
    const result = currentProofPacketExport();
    if (!result.ok) {
      setProofPacketExportStatus(`blocked: ${result.reason}`);
      return result;
    }
    const blob = new Blob([result.text + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "oma-covenant-controls-proof-packet-preview.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setProofPacketExportStatus("download prepared for preview-only proof packet; signing/broadcasting/minting remain disabled");
    return { ok: true, action: "download", packet_kind: result.packet.proof_packet_kind };
  }

  document.addEventListener("DOMContentLoaded", function () {
    ensureInspectionPanel();
    ensureTemplateRegistryPanel();
    ensureProofPacketExportPanel();
    if (UI.refreshSdk) UI.refreshSdk.addEventListener("click", loadToccataSdk);
    if (UI.buildPreview) UI.buildPreview.addEventListener("click", buildPreviewPacket);
    if (UI.inspectRefresh) UI.inspectRefresh.addEventListener("click", function () { resetInspectionPagination(); loadCovenantInspection(); });
    if (UI.inspectPrev) UI.inspectPrev.addEventListener("click", handleInspectionPageButton);
    if (UI.inspectNext) UI.inspectNext.addEventListener("click", handleInspectionPageButton);
    if (UI.inspectSort) UI.inspectSort.addEventListener("change", handleInspectionSortChange);
    if (UI.registryRefresh) UI.registryRefresh.addEventListener("click", loadTemplateRegistry);
    if (UI.proofPacketCopy) UI.proofPacketCopy.addEventListener("click", function () { copyProofPacket().catch(function (e) { setProofPacketExportStatus(String(e && e.message ? e.message : e)); }); });
    if (UI.proofPacketDownload) UI.proofPacketDownload.addEventListener("click", downloadProofPacket);
    document.addEventListener("click", function (event) { handleInspectionCopyClick(event).catch(function () {}); });
    document.addEventListener("click", function (event) { handleProgrammableKasInspectionAppLoadClick(event).catch(function () {}); });
    protectKasSetSubmitEnabled(UI.protectKasSubmitButton, false);
    protectKasSetSubmitEnabled(UI.protectKasReleaseSubmitButton, false);
    if (UI.protectKasBuildButton) UI.protectKasBuildButton.addEventListener("click", function () { handleProtectKasAction(protectKasBuild); });
    if (UI.protectKasSubmitButton) UI.protectKasSubmitButton.addEventListener("click", function () { handleProtectKasAction(protectKasSubmit); });
    if (UI.protectKasReleaseBuildButton) UI.protectKasReleaseBuildButton.addEventListener("click", function () { handleProtectKasAction(protectKasReleaseBuild); });
    if (UI.protectKasReleaseSubmitButton) UI.protectKasReleaseSubmitButton.addEventListener("click", function () { handleProtectKasAction(protectKasReleaseSubmit); });
    initProgrammableKasAppBuildOnlyWiring();
    Promise.all([loadToccataSdk(), loadTemplateRegistry()]).then(function (results) {
      const report = results[0];
      const registry = results[1];
      setText(UI.previewPacket, JSON.stringify({
        packet_kind: "oma_covenant_controls_page_loaded_v1",
        application_status: "preview_only",
        sdk_bridge: report,
        template_registry: registry ? {
          registry_kind: registry.registry_kind,
          registry_version: registry.registry_version,
          template_count: asArray(registry.templates).length,
          network_policy: registry.network_policy,
          safety_state: registry.safety_state
        } : {
          loaded: false,
          error: templateRegistryState.error || "not_loaded"
        },
        live_actions: "disabled"
      }, null, 2));
    });
    loadCovenantInspection();
  });
})();
