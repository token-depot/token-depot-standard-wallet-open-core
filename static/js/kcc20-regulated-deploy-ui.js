const POLICY_REGISTRY_BUILD_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/policy-registry/deploy/build";
const POLICY_REGISTRY_SUBMIT_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/policy-registry/deploy/submit";
const DEMO_POLICY_CURRENT_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/demo-policy/current";
const DEMO_POLICY_CREATE_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/demo-policy/create";
const DEMO_POLICY_UPDATE_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/demo-policy/update";
const DEMO_POLICY_RESET_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/demo-policy/reset";
const DEMO_POLICY_EXPORT_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/demo-policy/export";
const REGULATED_SEIZE_BUILD_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/control/seize/build";
const REGULATED_SEIZE_SUBMIT_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/control/seize/submit";
const REGULATED_FORCED_BURN_BUILD_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/control/forced-burn/build";
const REGULATED_FORCED_BURN_SUBMIT_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/control/forced-burn/submit";
const CONTROLLER_SUPPLY_BURN_BUILD_ROUTE = "/api/covenants/issuer-token/burn/controller-supply/build";
const CONTROLLER_SUPPLY_BURN_SUBMIT_ROUTE = "/api/covenants/issuer-token/burn/controller-supply/submit";
const REGULATED_TOKEN_METADATA_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/token-metadata";
const REGULATED_AUDIT_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/audit";
const REGULATED_AUDIT_EXPORT_ROUTE = "/api/covenants/issuer-token/kcc20-regulated/audit/export";
const REGULATED_AUDIT_REPORT_KIND = "kcc20_regulated_testnet_audit_report_v1";
const REGULATED_SEIZE_DEMO_UNLOCK = "TN10-DEMO-LAWFUL-ORDER";

const policyRegistryDeployState = {
  authoritative: null,
  walletReady: false,
  activeStatus: null,
  build: null,
  signedSafeJson: "",
  submitting: false,
  orchestrating: false,
  recovering: false,
  liveRegistry: null,
  recoveryError: null
};

const demoPolicyState = {
  walletReady: false,
  activeStatus: null,
  busy: false,
  policy: null,
  rulebook: null,
  sourceSnapshotId: "",
  rulebookRoot: "",
  registryPublicationRequired: null
};

const controlState = {
  busy: false
};

const seizeState = {
  unlocked: false,
  busy: false,
  build: null,
  signedSafeJson: ""
};

const forcedBurnState = {
  unlocked: false,
  busy: false,
  build: null,
  signedSafeJson: ""
};

const regulatedDeployEnrollmentState = {
  busy: false,
  assetCovenantId: ""
};

const regulatedAuditState = {
  loading: false,
  exporting: false,
  completingSupply: false,
  requestSerial: 0,
  report: null,
  pendingSupplyAction: null,
  searchTimer: null
};

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value == null || value === "" ? "—" : String(value);
}

function setCount(id, counts, key) {
  const value = counts && Number.isInteger(counts[key]) ? counts[key] : null;
  setText(id, value == null ? "—" : value);
}

function demoPolicySetStatus(state, label, message) {
  const badge = byId("crDemoPolicyStatus");
  if (badge) {
    badge.dataset.state = state;
    badge.textContent = label;
  }
  setText("crDemoPolicyMessage", message);
}

function renderControlProof(value) {
  const wrap = byId("crControlProofWrap");
  const proof = byId("crControlProof");
  if (proof) proof.textContent = JSON.stringify(value, null, 2);
  if (wrap) wrap.hidden = false;
}

function controlActionOrThrow() {
  const action = String(byId("crControlAction")?.value || "").trim();
  if (!new Set(["freeze_holder", "unfreeze_holder", "freeze_outpoint", "unfreeze_outpoint"]).has(action)) {
    throw new Error("kcc20_regulated_control_action_invalid");
  }
  return action;
}

function controlTargetOrThrow(action) {
  const target = String(byId("crControlTarget")?.value || "").trim().toLowerCase();
  if (action.endsWith("_holder")) {
    if (!/^kaspatest:[a-z0-9]+$/.test(target)) {
      throw new Error("kcc20_regulated_control_holder_address_invalid");
    }
  } else if (!/^[0-9a-f]{64}:\d+$/.test(target)) {
    throw new Error("kcc20_regulated_control_holder_outpoint_invalid");
  }
  return target;
}

function controlPolicyMutationOrThrow(action, target) {
  if (!demoPolicyState.policy) throw new Error("kcc20_regulated_control_saved_demo_policy_required");
  const policy = demoPolicyContent(demoPolicyState.policy);
  const listName = action.endsWith("_holder") ? "frozen_holders" : "frozen_outpoints";
  const freeze = action.startsWith("freeze_");
  const values = new Set(policy[listName]);
  if (freeze && values.has(target)) throw new Error("kcc20_regulated_control_target_already_frozen");
  if (!freeze && !values.has(target)) throw new Error("kcc20_regulated_control_target_not_frozen");
  if (freeze) values.add(target);
  else values.delete(target);
  policy[listName] = [...values].sort((a, b) => a.localeCompare(b));
  return { policy, listName, freeze };
}

function policyRegistryAuthorityState() {
  const live = policyRegistryDeployState.liveRegistry;
  const authorityAddress = String(live?.authority_address || live?.required_authority_address || "").trim();
  const activeAddress = String(policyRegistryDeployState.activeStatus?.address0 || "").trim();
  const explicit = live?.active_wallet_is_registry_authority;
  const activeWalletIsAuthority = explicit === true
    || (explicit !== false && !!authorityAddress && authorityAddress === activeAddress);
  return Object.freeze({ authorityAddress, activeAddress, activeWalletIsAuthority });
}

function controlPreparationReady() {
  return demoPolicyState.walletReady
    && !!demoPolicyState.policy
    && policyRegistryLiveMatchesAuthoritative()
    && !demoPolicyState.busy
    && !controlState.busy
    && !policyRegistryDeployState.orchestrating
    && !policyRegistryDeployState.submitting
    && !policyRegistryDeployState.recovering;
}

function controlReady() {
  return controlPreparationReady() && policyRegistryAuthorityState().activeWalletIsAuthority;
}

function updateControlControls() {
  const preparationReady = controlPreparationReady();
  const publishReady = controlReady();
  const authority = policyRegistryAuthorityState();
  const action = byId("crControlAction");
  const target = byId("crControlTarget");
  const apply = byId("crControlApplyBtn");
  if (action) action.disabled = !preparationReady;
  if (target) target.disabled = !preparationReady;
  if (apply) {
    apply.disabled = !publishReady;
    apply.textContent = controlState.busy ? "Applying Control…" : "Apply Control";
    apply.title = publishReady
      ? "Save the control as the next Demo Policy epoch and publish it to the same Registry."
      : (preparationReady && authority.authorityAddress
        ? `Select Registry authority wallet ${authority.authorityAddress} to apply and publish this control.`
        : "Complete the current policy and Registry requirements first.");
  }
}

function renderControlContext(messageOverride = "") {
  const policy = demoPolicyState.policy;
  const live = policyRegistryDeployState.liveRegistry;
  const liveMatches = policyRegistryLiveMatchesAuthoritative();
  setText("crControlPolicyEpoch", policy?.policy_epoch ?? "—");
  setText("crControlRegistry", live?.registry_covenant_id || "—");
  setText("crControlFrozenHolderCount", Array.isArray(policy?.frozen_holders) ? policy.frozen_holders.length : "—");
  setText("crControlFrozenOutpointCount", Array.isArray(policy?.frozen_outpoints) ? policy.frozen_outpoints.length : "—");
  if (messageOverride) {
    setText("crControlStatus", messageOverride);
  } else if (controlState.busy) {
    setText("crControlStatus", "Applying the policy change and publishing the same Registry…");
  } else if (!demoPolicyState.walletReady) {
    setText("crControlStatus", "A READY Testnet-10 wallet is required.");
  } else if (!policy) {
    setText("crControlStatus", "Load or create the saved Demo Policy first.");
  } else if (!live) {
    setText("crControlStatus", "Recover the user-owned Policy Registry before applying Controls.");
  } else if (!liveMatches) {
    setText("crControlStatus", `Publish Demo Policy epoch ${policy.policy_epoch} to the same Registry before applying another control.`);
  } else {
    const authority = policyRegistryAuthorityState();
    setText("crControlStatus", authority.activeWalletIsAuthority
      ? `Ready. Registry matches Demo Policy epoch ${policy.policy_epoch}.`
      : (authority.authorityAddress
        ? `Control fields are available. Select Registry authority wallet ${authority.authorityAddress} to apply and publish.`
        : `Registry matches Demo Policy epoch ${policy.policy_epoch}; its authority wallet is required to publish Controls.`));
  }
  updateControlControls();
  updateSeizeControls();
  updateForcedBurnControls();
}


function renderSeizeProof(value) {
  const wrap = byId("crSeizeProofWrap");
  const proof = byId("crSeizeProof");
  if (proof) proof.textContent = JSON.stringify(value, null, 2);
  if (wrap) wrap.hidden = false;
}

function controlEnabledSeizeAssets() {
  return issueDepositState.regulatedAssets.filter((asset) =>
    asset.holder_script_profile === "regulated_registry_control_v1"
    && asset.regulated_profile?.pr === String(policyRegistryDeployState.liveRegistry?.registry_covenant_id || "").trim().toLowerCase()
  );
}

function selectedSeizeAsset() {
  const assetId = String(byId("crSeizeAsset")?.value || "").trim().toLowerCase();
  return controlEnabledSeizeAssets().find((asset) => asset.asset_covenant_id === assetId) || null;
}

function populateSeizeAssets(preferredAssetId = "") {
  const select = byId("crSeizeAsset");
  if (!select) return;
  const assets = controlEnabledSeizeAssets();
  const preferred = String(preferredAssetId || "").trim().toLowerCase();
  const previous = String(select.value || "").trim().toLowerCase();
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = assets.length
    ? "Select control-enabled KCC20-Regulated token"
    : "No control-enabled issuer token available";
  select.appendChild(empty);
  for (const asset of assets) {
    const option = document.createElement("option");
    option.value = asset.asset_covenant_id;
    option.textContent = `${asset.token_symbol} · ${shortIssueValue(asset.asset_covenant_id)} · profile epoch ${asset.regulated_profile.pe}`;
    select.appendChild(option);
  }
  if (preferred && assets.some((asset) => asset.asset_covenant_id === preferred)) select.value = preferred;
  else if (previous && assets.some((asset) => asset.asset_covenant_id === previous)) select.value = previous;
  else if (assets.length === 1) select.value = assets[0].asset_covenant_id;
  updateSeizeControls();
}

function seizeRawAmountOrThrow() {
  const value = String(byId("crSeizeAmountRaw")?.value || "").trim();
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("kcc20_regulated_seize_amount_raw_must_be_positive");
  return value;
}

function seizeInputsOrThrow() {
  const asset = selectedSeizeAsset();
  if (!asset) throw new Error("kcc20_regulated_seize_asset_required");
  const targetHolderAddress = String(byId("crSeizeTargetHolderAddress")?.value || "").trim().toLowerCase();
  const targetHolderOutpoint = String(byId("crSeizeTargetHolderOutpoint")?.value || "").trim().toLowerCase();
  if (!targetHolderAddress && !targetHolderOutpoint) throw new Error("kcc20_regulated_seize_target_holder_required");
  if (targetHolderAddress && !/^kaspatest:[a-z0-9]+$/.test(targetHolderAddress)) {
    throw new Error("kcc20_regulated_seize_target_holder_address_invalid");
  }
  if (targetHolderOutpoint && !/^[0-9a-f]{64}:\d+$/.test(targetHolderOutpoint)) {
    throw new Error("kcc20_regulated_seize_target_holder_outpoint_invalid");
  }
  const destinationAddress = String(byId("crSeizeDestinationAddress")?.value || "").trim();
  if (!/^kaspatest:[a-z0-9]+$/.test(destinationAddress)) {
    throw new Error("kcc20_regulated_seize_destination_address_invalid");
  }
  const orderReference = String(byId("crSeizeOrderReference")?.value || "").trim();
  if (!orderReference || orderReference.length > 96) throw new Error("kcc20_regulated_seize_order_reference_required");
  return Object.freeze({
    asset,
    targetHolderAddress,
    targetHolderOutpoint,
    destinationAddress,
    orderReference,
    seizeAmountRaw: seizeRawAmountOrThrow()
  });
}

function seizePrerequisitesReady() {
  const authority = policyRegistryAuthorityState();
  return issueDepositState.walletReady
    && !!demoPolicyState.policy
    && policyRegistryLiveMatchesAuthoritative()
    && authority.activeWalletIsAuthority
    && controlEnabledSeizeAssets().length > 0
    && !seizeState.busy
    && !forcedBurnState.busy
    && !controlState.busy
    && !policyRegistryDeployState.orchestrating
    && !policyRegistryDeployState.submitting
    && !policyRegistryDeployState.recovering;
}

function updateSeizeControls(messageOverride = "") {
  const ready = seizePrerequisitesReady();
  const authority = policyRegistryAuthorityState();
  const unlock = byId("crSeizeUnlockBtn");
  if (unlock) {
    unlock.disabled = !ready;
    unlock.textContent = seizeState.unlocked ? "Demo Lawful Order Unlocked" : "Unlock Demo Lawful Order";
  }
  setText("crSeizeUnlockStatus", seizeState.unlocked
    ? "Demo-only lawful-order authority is unlocked for one Testnet-10 seizure action."
    : (ready
      ? "Unlock the demo lawful-order authority to enable seizure fields."
      : (authority.authorityAddress && !authority.activeWalletIsAuthority
        ? `Select Registry authority wallet ${authority.authorityAddress}.`
        : "Complete the live policy, Registry, authority-wallet, and control-enabled-token prerequisites.")));
  const fieldsEnabled = ready && seizeState.unlocked;
  ["crSeizeAsset", "crSeizeTargetHolderAddress", "crSeizeTargetHolderOutpoint", "crSeizeAmountRaw", "crSeizeDestinationAddress", "crSeizeOrderReference"].forEach((id) => {
    const element = byId(id);
    if (element) element.disabled = !fieldsEnabled;
  });
  const execute = byId("crSeizeExecuteBtn");
  if (execute) {
    let complete = false;
    try { seizeInputsOrThrow(); complete = true; } catch { complete = false; }
    execute.disabled = !fieldsEnabled || !complete;
    execute.textContent = seizeState.busy ? "Seizing Tokens…" : "Seize Tokens";
  }
  if (messageOverride) setText("crSeizeStatus", messageOverride);
  else if (seizeState.busy) setText("crSeizeStatus", "Building, signing, and submitting the Testnet-10 seizure transaction…");
  else if (!ready) setText("crSeizeStatus", "Seizure requires the Registry-authority wallet, a current published policy, and a control-enabled token.");
  else if (!seizeState.unlocked) setText("crSeizeStatus", "Ready for Demo Lawful-Order unlock.");
  else setText("crSeizeStatus", "Demo Lawful Order unlocked. Enter a frozen holder, amount, destination, and order reference.");
}

function unlockDemoSeize() {
  if (!seizePrerequisitesReady()) return;
  const confirmed = window.confirm(
    "Unlock Demo Lawful-Order authority for one real Testnet-10 seizure?\n\n"
    + "This is demo-only, makes no claim of legal validity, and requires the Registry-authority wallet."
  );
  if (!confirmed) return;
  seizeState.unlocked = true;
  if (!String(byId("crSeizeDestinationAddress")?.value || "").trim()) {
    const destination = byId("crSeizeDestinationAddress");
    if (destination) destination.value = String(policyRegistryDeployState.activeStatus?.address0 || "");
  }
  updateSeizeControls();
}

function fillSeizeSignatureScript(tx, inputIndex, signatureScript, reason) {
  const inputs = tx && Array.isArray(tx.inputs) ? tx.inputs : [];
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || !inputs[inputIndex]) throw new Error(reason);
  inputs[inputIndex].signatureScript = signatureScript;
  tx.inputs = inputs;
}

async function signRegulatedSeizeBuild(build, keyring) {
  const txSafeJson = String(build?.txToSignSafeJson || "").trim();
  const context = build?.signing_context_public;
  if (!txSafeJson || !context || typeof context !== "object") throw new Error("kcc20_regulated_seize_unsigned_build_missing");

  const registryInputIndex = Number(context.registry_input_index);
  const fundingInputIndexes = Array.isArray(context.native_kas_funding_input_indexes)
    ? context.native_kas_funding_input_indexes.map(Number)
    : [];
  const fundingInputOutpoints = Array.isArray(context.native_kas_funding_input_outpoints)
    ? context.native_kas_funding_input_outpoints.map((value) => String(value || "").trim())
    : [];
  const nativeFundingInputs = Array.isArray(build.native_kas_funding_inputs)
    ? build.native_kas_funding_inputs
    : [];
  const holderControlIndexes = Array.isArray(context.holder_control_input_indexes)
    ? context.holder_control_input_indexes.map(Number)
    : [];
  const signIndexes = Array.isArray(build.signInputIndexes) ? build.signInputIndexes.map(Number) : [];

  if (!Number.isInteger(registryInputIndex) || registryInputIndex < 0) {
    throw new Error("kcc20_regulated_seize_registry_input_not_signable");
  }
  if (!fundingInputIndexes.length
    || fundingInputIndexes.some((index) => !Number.isInteger(index) || index < 0 || index === registryInputIndex)
    || new Set(fundingInputIndexes).size !== fundingInputIndexes.length) {
    throw new Error("kcc20_regulated_seize_funding_indexes_invalid");
  }
  const expectedSignIndexes = [registryInputIndex, ...fundingInputIndexes];
  if (signIndexes.length !== expectedSignIndexes.length
    || signIndexes.some((index, position) => index !== expectedSignIndexes[position])) {
    throw new Error("kcc20_regulated_seize_sign_indexes_invalid");
  }
  if (nativeFundingInputs.length !== fundingInputIndexes.length
    || fundingInputOutpoints.length !== fundingInputIndexes.length) {
    throw new Error("kcc20_regulated_seize_funding_plan_invalid");
  }
  for (let position = 0; position < fundingInputIndexes.length; position += 1) {
    const input = nativeFundingInputs[position];
    if (!input
      || Number(input.input_index) !== fundingInputIndexes[position]
      || String(input.outpoint || "").trim() !== fundingInputOutpoints[position]
      || input.normal_kas_input !== true) {
      throw new Error("kcc20_regulated_seize_funding_plan_mismatch");
    }
  }
  if (!holderControlIndexes.length
    || holderControlIndexes.some((index) => !Number.isInteger(index) || index < 0 || signIndexes.includes(index))) {
    throw new Error("kcc20_regulated_seize_holder_control_indexes_invalid");
  }
  const redeemScriptHex = String(context.source_registry_redeem_script_hex || "").trim();
  if (!/^[0-9a-f]+$/i.test(redeemScriptHex) || redeemScriptHex.length % 2 !== 0) {
    throw new Error("kcc20_regulated_seize_registry_redeem_script_missing");
  }
  const k = window.kaspa;
  const tx = k.Transaction.deserializeFromSafeJSON(txSafeJson);
  const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
  for (const index of holderControlIndexes) {
    if (!inputs[index] || !String(inputs[index].signatureScript || "").trim()) {
      throw new Error("kcc20_regulated_seize_holder_control_witness_missing");
    }
  }
  if (!inputs[registryInputIndex] || fundingInputIndexes.some((index) => !inputs[index])) {
    throw new Error("kcc20_regulated_seize_signing_input_missing");
  }
  const registryScript = k.ScriptBuilder.fromScript(redeemScriptHex);
  const registrySignature = k.createInputSignature(tx, registryInputIndex, keyring.privateKey, null);
  fillSeizeSignatureScript(
    tx,
    registryInputIndex,
    registryScript.encodePayToScriptHashSignatureScript(registrySignature),
    "kcc20_regulated_seize_registry_input_missing"
  );
  for (const fundingInputIndex of fundingInputIndexes) {
    fillSeizeSignatureScript(
      tx,
      fundingInputIndex,
      k.createInputSignature(tx, fundingInputIndex, keyring.privateKey, null),
      "kcc20_regulated_seize_funding_input_missing"
    );
  }
  tx.finalize();
  const signedSafeJson = tx.serializeToSafeJSON();
  k.Transaction.deserializeFromSafeJSON(signedSafeJson);
  return signedSafeJson;
}

async function seizeRegulatedTokensOneClick() {
  if (seizeState.busy || !seizeState.unlocked) return;
  const values = seizeInputsOrThrow();
  const authority = policyRegistryAuthorityState();
  if (!authority.activeWalletIsAuthority) throw new Error("kcc20_policy_registry_authority_wallet_required");
  const confirmed = window.confirm(
    `Seize ${values.seizeAmountRaw} raw ${values.asset.token_symbol} without the holder signature?\n\n`
    + `Target: ${values.targetHolderOutpoint || values.targetHolderAddress}\n`
    + `Destination: ${values.destinationAddress}\n`
    + `Demo order: ${values.orderReference}`
  );
  if (!confirmed) return;

  seizeState.busy = true;
  seizeState.build = null;
  seizeState.signedSafeJson = "";
  let finalStatusMessage = "";
  updateSeizeControls();
  updateForcedBurnControls();
  try {
    const recovered = await recoverCanonicalPolicyRegistry({ force: true, required: true, announce: false });
    if (!recovered || !policyRegistryLiveMatchesAuthoritative()) throw new Error("kcc20_regulated_seize_current_registry_required");
    if (!policyRegistryAuthorityState().activeWalletIsAuthority) throw new Error("kcc20_policy_registry_authority_wallet_required");
    const keyring = await activeIssueKeyringOrThrow(policyRegistryDeployState.activeStatus);
    const buildResponse = await fetch(REGULATED_SEIZE_BUILD_ROUTE, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        demo_lawful_order_unlock: REGULATED_SEIZE_DEMO_UNLOCK,
        order_reference: values.orderReference,
        asset_covenant_id: values.asset.asset_covenant_id,
        target_holder_address: values.targetHolderAddress || undefined,
        target_holder_outpoint: values.targetHolderOutpoint || undefined,
        seize_amount_raw: values.seizeAmountRaw,
        destination_address: values.destinationAddress
      })
    });
    const build = await buildResponse.json().catch(() => null);
    if (!buildResponse.ok || build?.ok !== true) throw new Error(String(build?.reason || `HTTP ${buildResponse.status}`));
    if (build.build_kind !== "kcc20_regulated_seize_build_v1"
      || build.submit_route !== REGULATED_SEIZE_SUBMIT_ROUTE
      || build.submit_intent !== "submit_kcc20_regulated_seize_v1"
      || build.demo_lawful_order?.unlock_kind !== REGULATED_SEIZE_DEMO_UNLOCK
      || build.asset_covenant_id !== values.asset.asset_covenant_id
      || build.registry_covenant_id !== String(policyRegistryDeployState.liveRegistry?.registry_covenant_id || "").trim().toLowerCase()
      || !Array.isArray(build.signInputIndexes) || build.signInputIndexes.length < 2
      || !Array.isArray(build.signing_context_public?.native_kas_funding_input_indexes)
      || build.signing_context_public.native_kas_funding_input_indexes.length < 1
      || build.signing_enabled !== true || build.broadcasting_enabled !== false) {
      throw new Error("kcc20_regulated_seize_build_response_invalid");
    }
    seizeState.build = build;
    seizeState.signedSafeJson = await signRegulatedSeizeBuild(build, keyring);
    const submitResponse = await fetch(REGULATED_SEIZE_SUBMIT_ROUTE, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        submit_intent: build.submit_intent,
        submit_token: build.submit_token,
        signedSafeJson: seizeState.signedSafeJson
      })
    });
    const data = await submitResponse.json().catch(() => null);
    if (!submitResponse.ok || data?.ok !== true) throw new Error(String(data?.reason || `HTTP ${submitResponse.status}`));
    if (data.proof_kind !== "kcc20_regulated_tn10_seize_submit_v1"
      || data.action !== "seize"
      || data.asset_covenant_id !== values.asset.asset_covenant_id
      || data.holder_signature_required !== false
      || data.registry_authority_signature_required !== true
      || data.registry_covenant_id_continuity !== true
      || !/^[0-9a-f]{64}$/.test(String(data.submitted_txid || "").trim().toLowerCase())) {
      throw new Error("kcc20_regulated_seize_submit_response_invalid");
    }
    const seizureUserResult = data.live_verified === true
      ? `SUCCESS — Seizure completed and live-verified. ${data.seized_amount_raw} raw ${data.token_symbol} moved to ${data.destination_address} without the holder signature. Transaction: ${data.submitted_txid}`
      : `SUBMITTED — Seizure was accepted, but live verification is still pending. Do not repeat the seizure. Transaction: ${data.submitted_txid}`;
    renderSeizeProof({
      ok: true,
      user_result: seizureUserResult,
      proof_kind: data.proof_kind,
      application_status: data.application_status,
      action: data.action,
      order_reference: data.order_reference,
      asset_covenant_id: data.asset_covenant_id,
      token_symbol: data.token_symbol,
      source_holder_outpoints: data.source_holder_outpoints,
      seized_amount_raw: data.seized_amount_raw,
      holder_remainder_amount_raw: data.holder_remainder_amount_raw,
      destination_address: data.destination_address,
      holder_signature_required: false,
      registry_authority_signature_required: true,
      registry_covenant_id: data.registry_covenant_id,
      registry_covenant_id_continuity: data.registry_covenant_id_continuity,
      submitted_txid: data.submitted_txid,
      source_holder_spent: data.source_holder_spent,
      seized_output_visible: data.seized_output_visible,
      remainder_output_visible: data.remainder_output_visible,
      registry_output_visible: data.registry_output_visible,
      live_verified: data.live_verified,
      signed_transaction_json_echoed: false,
      signature_script_echoed: false
    });
    await recoverCanonicalPolicyRegistry({ force: true, required: true, announce: false });
    await refreshRegulatedIssueAssets(values.asset.asset_covenant_id);
    finalStatusMessage = seizureUserResult;
    seizeState.unlocked = false;
    ["crSeizeTargetHolderAddress", "crSeizeTargetHolderOutpoint", "crSeizeAmountRaw", "crSeizeOrderReference"].forEach((id) => {
      const element = byId(id);
      if (element) element.value = "";
    });
  } catch (errorValue) {
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_seize_failed";
    const seizureUserResult = `FAILED — Seizure was not completed. ${reason}`;
    renderSeizeProof({ ok: false, user_result: seizureUserResult, reason, holder_signature_required: false, signed_transaction_json_echoed: false, signature_script_echoed: false });
    finalStatusMessage = seizureUserResult;
  } finally {
    seizeState.busy = false;
    seizeState.build = null;
    seizeState.signedSafeJson = "";
    renderControlContext();
    updateSeizeControls(finalStatusMessage);
  }
}


function renderForcedBurnProof(value) {
  const wrap = byId("crForcedBurnProofWrap");
  const proof = byId("crForcedBurnProof");
  if (proof) proof.textContent = JSON.stringify(value, null, 2);
  if (wrap) wrap.hidden = false;
}

function controlEnabledForcedBurnAssets() {
  return controlEnabledSeizeAssets();
}

function selectedForcedBurnAsset() {
  const assetId = String(byId("crForcedBurnAsset")?.value || "").trim().toLowerCase();
  return controlEnabledForcedBurnAssets().find((asset) => asset.asset_covenant_id === assetId) || null;
}

function populateForcedBurnAssets(preferredAssetId = "") {
  const select = byId("crForcedBurnAsset");
  if (!select) return;
  const assets = controlEnabledForcedBurnAssets();
  const preferred = String(preferredAssetId || "").trim().toLowerCase();
  const previous = String(select.value || "").trim().toLowerCase();
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = assets.length
    ? "Select control-enabled KCC20-Regulated token"
    : "No control-enabled issuer token available";
  select.appendChild(empty);
  for (const asset of assets) {
    const option = document.createElement("option");
    option.value = asset.asset_covenant_id;
    option.textContent = `${asset.token_symbol} · ${shortIssueValue(asset.asset_covenant_id)} · profile epoch ${asset.regulated_profile.pe}`;
    select.appendChild(option);
  }
  if (preferred && assets.some((asset) => asset.asset_covenant_id === preferred)) select.value = preferred;
  else if (previous && assets.some((asset) => asset.asset_covenant_id === previous)) select.value = previous;
  else if (assets.length === 1) select.value = assets[0].asset_covenant_id;
  updateForcedBurnControls();
}

function forcedBurnInputsOrThrow() {
  const asset = selectedForcedBurnAsset();
  if (!asset) throw new Error("kcc20_regulated_forced_burn_asset_required");
  const targetHolderAddress = String(byId("crForcedBurnTargetHolderAddress")?.value || "").trim().toLowerCase();
  if (!/^kaspatest:[a-z0-9]+$/.test(targetHolderAddress)) {
    throw new Error("kcc20_regulated_forced_burn_target_holder_address_invalid");
  }
  const burnAmountRaw = String(byId("crForcedBurnAmountRaw")?.value || "").trim();
  if (!/^[1-9][0-9]*$/.test(burnAmountRaw)) {
    throw new Error("kcc20_regulated_forced_burn_amount_raw_must_be_positive");
  }
  const orderReference = String(byId("crForcedBurnOrderReference")?.value || "").trim();
  if (!orderReference || orderReference.length > 96) {
    throw new Error("kcc20_regulated_forced_burn_order_reference_required");
  }
  return Object.freeze({ asset, targetHolderAddress, burnAmountRaw, orderReference });
}

function forcedBurnPrerequisitesReady() {
  return controlReady()
    && controlEnabledForcedBurnAssets().length > 0
    && !forcedBurnState.busy
    && !seizeState.busy;
}

function updateForcedBurnControls(messageOverride = "") {
  const ready = forcedBurnPrerequisitesReady();
  const unlock = byId("crForcedBurnUnlockBtn");
  if (unlock) {
    unlock.disabled = !ready;
    unlock.textContent = forcedBurnState.unlocked ? "Demo Lawful Order Unlocked" : "Unlock Demo Lawful Order";
  }
  setText("crForcedBurnUnlockStatus", forcedBurnState.unlocked
    ? "Unlocked for one real Testnet-10 forced burn."
    : "Locked.");
  const fieldsEnabled = ready && forcedBurnState.unlocked;
  ["crForcedBurnAsset", "crForcedBurnTargetHolderAddress", "crForcedBurnAmountRaw", "crForcedBurnOrderReference"].forEach((id) => {
    const element = byId(id);
    if (element) element.disabled = !fieldsEnabled;
  });
  const execute = byId("crForcedBurnExecuteBtn");
  if (execute) {
    let complete = false;
    try { forcedBurnInputsOrThrow(); complete = true; } catch { complete = false; }
    execute.disabled = !fieldsEnabled || !complete;
    execute.textContent = forcedBurnState.busy ? "Force Burning Tokens…" : "Force Burn Tokens";
  }
  if (messageOverride) setText("crForcedBurnStatus", messageOverride);
  else if (forcedBurnState.busy) setText("crForcedBurnStatus", "Building, signing, and submitting the forced burn, then updating controller supply…");
  else if (!ready) setText("crForcedBurnStatus", "Forced burn requires the Registry-authority/controller wallet, a current published policy, and a control-enabled token.");
  else if (!forcedBurnState.unlocked) setText("crForcedBurnStatus", "Ready for Demo Lawful-Order unlock.");
  else setText("crForcedBurnStatus", "Demo Lawful Order unlocked. Enter the frozen holder wallet, burn amount, and order reference.");
}

function unlockDemoForcedBurn() {
  if (!forcedBurnPrerequisitesReady()) return;
  const confirmed = window.confirm(
    "Unlock Demo Lawful-Order authority for one real Testnet-10 forced burn?\n\n"
    + "The frozen holder will not sign. The Registry-authority wallet will sign the control transaction."
  );
  if (!confirmed) return;
  forcedBurnState.unlocked = true;
  updateForcedBurnControls();
}

async function signForcedBurnControllerSupplyBuild(build, keyring) {
  const txSafeJson = String(build?.txToSignSafeJson || "").trim();
  const context = build?.signing_context_public;
  if (!txSafeJson || !context || typeof context !== "object") {
    throw new Error("kcc20_regulated_forced_burn_controller_supply_unsigned_build_missing");
  }

  const controllerInputIndex = Number(context.controller_input_index);
  const fundingInputIndexes = Array.isArray(context.native_kas_funding_input_indexes)
    ? context.native_kas_funding_input_indexes.map(Number)
    : [];
  const fundingInputOutpoints = Array.isArray(context.native_kas_funding_input_outpoints)
    ? context.native_kas_funding_input_outpoints.map((value) => String(value || "").trim())
    : [];
  const nativeFundingInputs = Array.isArray(build.native_kas_funding_inputs)
    ? build.native_kas_funding_inputs
    : [];
  const signIndexes = Array.isArray(build.signInputIndexes)
    ? build.signInputIndexes.map(Number)
    : [];

  if (!Number.isInteger(controllerInputIndex) || controllerInputIndex < 0) {
    throw new Error("kcc20_regulated_forced_burn_controller_supply_controller_input_invalid");
  }
  if (!fundingInputIndexes.length
    || fundingInputIndexes.some((index) => !Number.isInteger(index) || index < 0 || index === controllerInputIndex)
    || new Set(fundingInputIndexes).size !== fundingInputIndexes.length) {
    throw new Error("kcc20_regulated_forced_burn_controller_supply_funding_indexes_invalid");
  }
  const expectedSignIndexes = [controllerInputIndex, ...fundingInputIndexes];
  if (signIndexes.length !== expectedSignIndexes.length
    || signIndexes.some((index, position) => index !== expectedSignIndexes[position])) {
    throw new Error("kcc20_regulated_forced_burn_controller_supply_sign_indexes_invalid");
  }
  if (nativeFundingInputs.length !== fundingInputIndexes.length
    || fundingInputOutpoints.length !== fundingInputIndexes.length) {
    throw new Error("kcc20_regulated_forced_burn_controller_supply_funding_plan_invalid");
  }
  for (let position = 0; position < fundingInputIndexes.length; position += 1) {
    const input = nativeFundingInputs[position];
    if (Number(input?.input_index) !== fundingInputIndexes[position]
      || String(input?.outpoint || "").trim() !== fundingInputOutpoints[position]
      || input?.normal_kas_input !== true) {
      throw new Error("kcc20_regulated_forced_burn_controller_supply_funding_plan_mismatch");
    }
  }

  const redeemScriptHex = String(context.source_controller_redeem_script_hex || "").trim();
  if (!/^[0-9a-f]+$/i.test(redeemScriptHex) || redeemScriptHex.length % 2 !== 0) {
    throw new Error("kcc20_regulated_forced_burn_controller_supply_redeem_script_missing");
  }

  const k = window.kaspa;
  const tx = k.Transaction.deserializeFromSafeJSON(txSafeJson);
  const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
  if (!inputs[controllerInputIndex]
    || fundingInputIndexes.some((index) => !inputs[index])) {
    throw new Error("kcc20_regulated_forced_burn_controller_supply_input_missing");
  }

  const controllerScript = k.ScriptBuilder.fromScript(redeemScriptHex);
  const dummySignature = new Uint8Array(65);
  fillIssueSignatureScript(
    tx,
    controllerInputIndex,
    controllerScript.encodePayToScriptHashSignatureScript(dummySignature),
    "kcc20_regulated_forced_burn_controller_supply_controller_input_missing"
  );
  const controllerSignature = k.createInputSignature(tx, controllerInputIndex, keyring.privateKey, null);
  fillIssueSignatureScript(
    tx,
    controllerInputIndex,
    controllerScript.encodePayToScriptHashSignatureScript(controllerSignature),
    "kcc20_regulated_forced_burn_controller_supply_controller_input_missing"
  );
  for (const fundingInputIndex of fundingInputIndexes) {
    const fundingSignature = k.createInputSignature(tx, fundingInputIndex, keyring.privateKey, null);
    fillIssueSignatureScript(
      tx,
      fundingInputIndex,
      fundingSignature,
      "kcc20_regulated_forced_burn_controller_supply_funding_input_missing"
    );
  }

  tx.finalize();
  const signedSafeJson = tx.serializeToSafeJSON();
  k.Transaction.deserializeFromSafeJSON(signedSafeJson);
  return signedSafeJson;
}

async function autoSubmitForcedBurnControllerSupplyUpdate(assetCovenantId, keyring, receiptConstraint = null) {
  const assetId = String(assetCovenantId || "").trim().toLowerCase();
  const constrainedReceiptTxid = String(receiptConstraint?.burnReceiptTxid || "").trim().toLowerCase();
  const constrainedBurnAmountRaw = String(receiptConstraint?.burnAmountRaw || "").trim();
  if (constrainedReceiptTxid && !/^[0-9a-f]{64}$/.test(constrainedReceiptTxid)) {
    throw new Error("kcc20_regulated_controller_supply_receipt_txid_invalid");
  }
  if (constrainedBurnAmountRaw && (!/^\d+$/.test(constrainedBurnAmountRaw) || BigInt(constrainedBurnAmountRaw) <= 0n)) {
    throw new Error("kcc20_regulated_controller_supply_burn_amount_invalid");
  }
  const proof = {
    proof_kind: "kcc20_regulated_forced_burn_auto_controller_supply_update_v1",
    asset_covenant_id: assetId,
    burn_receipt_txid: constrainedReceiptTxid || null,
    build_ok: false,
    sign_ok: false,
    submit_ok: false,
    controller_supply_update_status: null,
    signed_transaction_json_echoed: false,
    signature_script_echoed: false,
    minting: "none"
  };
  try {
    if (!/^[0-9a-f]{64}$/.test(assetId)) throw new Error("kcc20_regulated_forced_burn_asset_covenant_id_invalid");
    const buildResponse = await fetch(CONTROLLER_SUPPLY_BURN_BUILD_ROUTE, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_covenant_id: assetId,
        owner_public_key: keyring.owner_public_key,
        ...(constrainedReceiptTxid ? { burn_receipt_txid: constrainedReceiptTxid } : {})
      })
    });
    const build = await buildResponse.json().catch(() => null);
    if (!buildResponse.ok || build?.ok !== true) throw new Error(String(build?.reason || `HTTP ${buildResponse.status}`));
    if (build.supply_update_build_kind !== "oma_l1_burn_controller_supply_build_v1"
      || build.submit_route !== CONTROLLER_SUPPLY_BURN_SUBMIT_ROUTE
      || build.submit_intent_required !== "submit_oma_l1_burn_controller_supply_v1"
      || build.submit_route_enabled !== true
      || !Array.isArray(build.signInputIndexes) || build.signInputIndexes.length < 2
      || !Array.isArray(build.signing_context_public?.native_kas_funding_input_indexes)
      || build.signing_context_public.native_kas_funding_input_indexes.length < 1
      || build.signing_enabled !== false || build.broadcasting_enabled !== false) {
      throw new Error("kcc20_regulated_forced_burn_controller_supply_build_response_invalid");
    }
    if (constrainedReceiptTxid) {
      const selectedReceiptTxids = Array.isArray(build.burn_receipts?.submitted_txids)
        ? build.burn_receipts.submitted_txids.map((value) => String(value || "").trim().toLowerCase())
        : [];
      if (build.burn_receipts?.selected_count !== 1
        || selectedReceiptTxids.length !== 1
        || selectedReceiptTxids[0] !== constrainedReceiptTxid
        || (constrainedBurnAmountRaw && String(build.token_definition?.burn_amount_raw || "").trim() !== constrainedBurnAmountRaw)) {
        throw new Error("kcc20_regulated_controller_supply_receipt_binding_mismatch");
      }
    }
    proof.build_ok = true;
    proof.issued_supply_before_raw = build.issued_supply_before_raw;
    proof.issued_supply_after_raw = build.issued_supply_after_raw;
    const signedSafeJson = await signForcedBurnControllerSupplyBuild(build, keyring);
    proof.sign_ok = true;
    proof.native_kas_funding_input_count = build.signing_context_public.native_kas_funding_input_indexes.length;
    const submitResponse = await fetch(CONTROLLER_SUPPLY_BURN_SUBMIT_ROUTE, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        submit_intent: "submit_oma_l1_burn_controller_supply_v1",
        submit_token: build.submit_token,
        signedSafeJson
      })
    });
    const submit = await submitResponse.json().catch(() => null);
    if (!submitResponse.ok || submit?.ok !== true) throw new Error(String(submit?.reason || `HTTP ${submitResponse.status}`));
    if (submit.submit_kind !== "oma_l1_burn_controller_supply_submit_v1"
      || submit.asset_covenant_id !== assetId
      || !/^[0-9a-f]{64}$/.test(String(submit.submitted_txid || "").trim().toLowerCase())) {
      throw new Error("kcc20_regulated_forced_burn_controller_supply_submit_response_invalid");
    }
    if (constrainedReceiptTxid) {
      const updatedReceiptTxids = Array.isArray(submit.burn_receipts?.submitted_txids)
        ? submit.burn_receipts.submitted_txids.map((value) => String(value || "").trim().toLowerCase())
        : [];
      if (submit.burn_receipts?.updated_count !== 1
        || updatedReceiptTxids.length !== 1
        || updatedReceiptTxids[0] !== constrainedReceiptTxid
        || submit.burn_receipts?.controller_supply_update_status !== "updated_after_controller_supply_submit_v1"
        || (constrainedBurnAmountRaw && String(submit.supply_update_result?.burn_amount_raw || "").trim() !== constrainedBurnAmountRaw)) {
        throw new Error("kcc20_regulated_controller_supply_receipt_completion_mismatch");
      }
    }
    proof.submit_ok = true;
    proof.application_status = submit.application_status;
    proof.submitted_txid = submit.submitted_txid;
    proof.issued_supply_after_raw = submit.supply_update_result?.issued_supply_after_raw ?? proof.issued_supply_after_raw;
    proof.controller_supply_update_status = submit.burn_receipts?.controller_supply_update_status || null;
    return proof;
  } catch (errorValue) {
    proof.reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_forced_burn_controller_supply_update_failed";
    return proof;
  }
}

async function forceBurnRegulatedTokensOneClick() {
  if (forcedBurnState.busy || !forcedBurnState.unlocked) return;
  const values = forcedBurnInputsOrThrow();
  const authority = policyRegistryAuthorityState();
  if (!authority.activeWalletIsAuthority) throw new Error("kcc20_policy_registry_authority_wallet_required");
  const confirmed = window.confirm(
    `Force burn ${values.burnAmountRaw} raw ${values.asset.token_symbol} from the frozen holder wallet without its signature?\n\n`
    + `Frozen holder: ${values.targetHolderAddress}\n`
    + `Demo order: ${values.orderReference}`
  );
  if (!confirmed) return;

  forcedBurnState.busy = true;
  forcedBurnState.build = null;
  forcedBurnState.signedSafeJson = "";
  let finalStatusMessage = "";
  updateForcedBurnControls();
  updateSeizeControls();
  try {
    const recovered = await recoverCanonicalPolicyRegistry({ force: true, required: true, announce: false });
    if (!recovered || !policyRegistryLiveMatchesAuthoritative()) throw new Error("kcc20_regulated_forced_burn_current_registry_required");
    if (!policyRegistryAuthorityState().activeWalletIsAuthority) throw new Error("kcc20_policy_registry_authority_wallet_required");
    const keyring = await activeIssueKeyringOrThrow(policyRegistryDeployState.activeStatus);
    const buildResponse = await fetch(REGULATED_FORCED_BURN_BUILD_ROUTE, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        demo_lawful_order_unlock: REGULATED_SEIZE_DEMO_UNLOCK,
        order_reference: values.orderReference,
        asset_covenant_id: values.asset.asset_covenant_id,
        target_holder_address: values.targetHolderAddress,
        burn_amount_raw: values.burnAmountRaw
      })
    });
    const build = await buildResponse.json().catch(() => null);
    if (!buildResponse.ok || build?.ok !== true) throw new Error(String(build?.reason || `HTTP ${buildResponse.status}`));
    if (build.build_kind !== "kcc20_regulated_forced_burn_build_v1"
      || build.submit_route !== REGULATED_FORCED_BURN_SUBMIT_ROUTE
      || build.submit_intent !== "submit_kcc20_regulated_forced_burn_v1"
      || build.demo_lawful_order?.unlock_kind !== REGULATED_SEIZE_DEMO_UNLOCK
      || build.asset_covenant_id !== values.asset.asset_covenant_id
      || build.target_holder_address !== values.targetHolderAddress
      || build.registry_covenant_id !== String(policyRegistryDeployState.liveRegistry?.registry_covenant_id || "").trim().toLowerCase()
      || !Array.isArray(build.signInputIndexes) || build.signInputIndexes.length < 2
      || !Array.isArray(build.signing_context_public?.native_kas_funding_input_indexes)
      || build.signing_context_public.native_kas_funding_input_indexes.length < 1
      || build.signing_enabled !== true || build.broadcasting_enabled !== false) {
      throw new Error("kcc20_regulated_forced_burn_build_response_invalid");
    }
    forcedBurnState.build = build;
    forcedBurnState.signedSafeJson = await signRegulatedSeizeBuild(build, keyring);
    const submitResponse = await fetch(REGULATED_FORCED_BURN_SUBMIT_ROUTE, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        submit_intent: build.submit_intent,
        submit_token: build.submit_token,
        signedSafeJson: forcedBurnState.signedSafeJson
      })
    });
    const data = await submitResponse.json().catch(() => null);
    if (!submitResponse.ok || data?.ok !== true) throw new Error(String(data?.reason || `HTTP ${submitResponse.status}`));
    if (data.proof_kind !== "kcc20_regulated_tn10_forced_burn_submit_v1"
      || data.action !== "forced_burn"
      || data.asset_covenant_id !== values.asset.asset_covenant_id
      || data.target_holder_address !== values.targetHolderAddress
      || data.holder_signature_required !== false
      || data.registry_authority_signature_required !== true
      || data.registry_covenant_id_continuity !== true
      || !/^[0-9a-f]{64}$/.test(String(data.submitted_txid || "").trim().toLowerCase())) {
      throw new Error("kcc20_regulated_forced_burn_submit_response_invalid");
    }
    setText("crForcedBurnStatus", "Forced burn submitted. Updating controller supply automatically…");
    const controllerSupplyUpdate = await autoSubmitForcedBurnControllerSupplyUpdate(values.asset.asset_covenant_id, keyring);
    let forcedBurnUserResult;
    if (data.live_verified === true && controllerSupplyUpdate.submit_ok === true) {
      forcedBurnUserResult = `SUCCESS — Forced burn completed and controller supply updated. ${data.burned_amount_raw} raw ${data.token_symbol} was permanently burned without the holder signature. Burn transaction: ${data.submitted_txid}. Controller update transaction: ${controllerSupplyUpdate.submitted_txid}`;
    } else if (data.live_verified === true) {
      forcedBurnUserResult = `FORCED BURN SUCCEEDED — Controller supply update remains pending. The forced burn completed and was live-verified. ${data.burned_amount_raw} raw ${data.token_symbol} was permanently burned without the holder signature. Controller supply accounting remains pending: ${controllerSupplyUpdate.reason || "controller update required"}. Do not repeat the forced burn. Burn transaction: ${data.submitted_txid}`;
    } else {
      forcedBurnUserResult = `SUBMITTED — Forced burn was accepted, but live verification is still pending. Do not repeat the forced burn. Burn transaction: ${data.submitted_txid}`;
    }
    renderForcedBurnProof({
      ok: true,
      user_result: forcedBurnUserResult,
      proof_kind: data.proof_kind,
      application_status: data.application_status,
      action: data.action,
      order_reference: data.order_reference,
      asset_covenant_id: data.asset_covenant_id,
      token_symbol: data.token_symbol,
      target_holder_address: data.target_holder_address,
      source_holder_outpoints: data.source_holder_outpoints,
      burned_amount_raw: data.burned_amount_raw,
      holder_remainder_amount_raw: data.holder_remainder_amount_raw,
      holder_signature_required: false,
      registry_authority_signature_required: true,
      registry_covenant_id: data.registry_covenant_id,
      registry_covenant_id_continuity: data.registry_covenant_id_continuity,
      submitted_txid: data.submitted_txid,
      source_holder_spent: data.source_holder_spent,
      remainder_output_visible: data.remainder_output_visible,
      holder_native_refund_visible: data.holder_native_refund_visible,
      registry_output_visible: data.registry_output_visible,
      authority_native_refund_visible: data.authority_native_refund_visible,
      live_verified: data.live_verified,
      burn_receipt: data.burn_receipt,
      controller_supply_update: controllerSupplyUpdate,
      signed_transaction_json_echoed: false,
      signature_script_echoed: false
    });
    await recoverCanonicalPolicyRegistry({ force: true, required: true, announce: false });
    await refreshRegulatedIssueAssets(values.asset.asset_covenant_id);
    finalStatusMessage = forcedBurnUserResult;
    forcedBurnState.unlocked = false;
    ["crForcedBurnTargetHolderAddress", "crForcedBurnAmountRaw", "crForcedBurnOrderReference"].forEach((id) => {
      const element = byId(id);
      if (element) element.value = "";
    });
  } catch (errorValue) {
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_forced_burn_failed";
    const forcedBurnUserResult = `FAILED — Forced burn was not completed. ${reason}`;
    renderForcedBurnProof({ ok: false, user_result: forcedBurnUserResult, reason, holder_signature_required: false, signed_transaction_json_echoed: false, signature_script_echoed: false });
    finalStatusMessage = forcedBurnUserResult;
  } finally {
    forcedBurnState.busy = false;
    forcedBurnState.build = null;
    forcedBurnState.signedSafeJson = "";
    renderControlContext();
    updateForcedBurnControls(finalStatusMessage);
  }
}

async function applyControlOneClick() {
  if (!controlReady()) return;
  controlState.busy = true;
  demoPolicyState.busy = true;
  renderControlContext();
  updateDemoPolicyButtons();
  updatePolicyRegistryButtons();
  const previousPolicy = demoPolicyState.policy;
  const previousEpoch = Number(previousPolicy?.policy_epoch || 0);
  let finalStatusMessage = "";
  try {
    const registryRecovered = await recoverCanonicalPolicyRegistry({ force: true, required: true, announce: false });
    if (!registryRecovered || !policyRegistryLiveMatchesAuthoritative()) {
      throw new Error("kcc20_regulated_control_current_registry_required");
    }
    if (!policyRegistryAuthorityState().activeWalletIsAuthority) {
      throw new Error("kcc20_policy_registry_authority_wallet_required");
    }
    const previousRegistryId = String(policyRegistryDeployState.liveRegistry?.registry_covenant_id || "").trim().toLowerCase();
    const action = controlActionOrThrow();
    const target = controlTargetOrThrow(action);
    const mutation = controlPolicyMutationOrThrow(action, target);
    setText("crControlStatus", `Saving ${action.replaceAll("_", " ")} as the next Demo Policy epoch…`);
    const { response, data } = await demoPolicyJsonRequest(DEMO_POLICY_UPDATE_ROUTE, {
      method: "POST",
      body: JSON.stringify({ policy: mutation.policy })
    });
    if (!response.ok) throw new Error(typeof data?.reason === "string" ? data.reason : `HTTP ${response.status}`);
    const saved = demoPolicyResponseOrThrow(data);
    if (saved.noOp || saved.writesToDisk !== true || saved.policy.policy_epoch !== previousEpoch + 1) {
      throw new Error("kcc20_regulated_control_policy_epoch_update_invalid");
    }
    if (stableJson(demoPolicyContent(saved.policy)) !== stableJson(mutation.policy)) {
      throw new Error("kcc20_regulated_control_saved_policy_mismatch");
    }
    demoPolicyRenderResponse(data, `Control saved as Demo Policy epoch ${saved.policy.policy_epoch}. Publishing the same Registry…`);
    await deployPolicyRegistryOneClick();
    if (!policyRegistryLiveMatchesAuthoritative()) {
      throw new Error("kcc20_regulated_control_registry_publication_failed");
    }
    const live = policyRegistryDeployState.liveRegistry;
    const registryId = String(live?.registry_covenant_id || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(registryId) || registryId !== previousRegistryId) {
      throw new Error("kcc20_regulated_control_registry_identity_changed");
    }
    renderControlProof({
      proof_kind: "kcc20_regulated_tn10_freeze_unfreeze_control_v1",
      application_status: "kcc20_regulated_control_policy_registry_live_verified_tn10",
      action,
      target,
      previous_policy_epoch: previousEpoch,
      policy_epoch: saved.policy.policy_epoch,
      source_policy_snapshot_id: saved.sourceSnapshotId,
      rulebook_root: saved.rulebookRoot,
      registry_covenant_id: registryId,
      registry_covenant_id_continuity: true,
      registry_submitted_txid: live?.submitted_txid || null,
      frozen_holder_count: saved.policy.frozen_holders.length,
      frozen_outpoint_count: saved.policy.frozen_outpoints.length,
      token_units_moved: false,
      signed_transaction_json_echoed: false,
      signature_script_echoed: false
    });
    finalStatusMessage = `${action.replaceAll("_", " ")} is live at Demo Policy epoch ${saved.policy.policy_epoch}. Prove it through the next real transfer.`;
    if (byId("crControlTarget")) byId("crControlTarget").value = "";
    await refreshRegulatedIssueAssets();
  } catch (errorValue) {
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_control_apply_failed";
    renderControlProof({ ok: false, reason, token_units_moved: false, signed_transaction_json_echoed: false, signature_script_echoed: false });
    finalStatusMessage = `Control failed: ${reason}`;
  } finally {
    controlState.busy = false;
    demoPolicyState.busy = false;
    renderControlContext(finalStatusMessage);
    updateDemoPolicyButtons();
    updatePolicyRegistryButtons();
  }
}

function demoPolicyContent(policy) {
  return {
    regulated_asset_covenant_ids: [...policy.regulated_asset_covenant_ids],
    recipient_allowlist: [...policy.recipient_allowlist],
    recipient_blacklist: [...policy.recipient_blacklist],
    frozen_holders: [...policy.frozen_holders],
    frozen_outpoints: [...policy.frozen_outpoints],
    lawful_order_actions: [...policy.lawful_order_actions]
  };
}

function demoPolicyArrayOrThrow(value, fieldName) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`kcc20_regulated_demo_policy_ui_${fieldName}_invalid`);
  }
  return [...value];
}

function demoPolicyResponseOrThrow(data) {
  if (!data || typeof data !== "object" || data.ok !== true) {
    throw new Error("kcc20_regulated_demo_policy_ui_response_invalid");
  }
  if (data.policy_source_mode !== "Testnet-10 Local Demo Policy"
    || data.local_demo_policy !== true
    || data.production_eligible !== false
    || data.mainnet_eligible !== false
    || data.token_depot_cn_policy_mutated !== false
    || data.token_depot_registry_mutated !== false
    || data.token_01_mutated !== false) {
    throw new Error("kcc20_regulated_demo_policy_ui_safety_boundary_invalid");
  }

  const policy = data.policy;
  if (!policy || typeof policy !== "object"
    || policy.schema_kind !== "kcc20_regulated_demo_policy_v1"
    || policy.schema_version !== 1
    || policy.network !== "testnet-10"
    || !Number.isInteger(policy.policy_epoch)
    || policy.policy_epoch < 1
    || policy.policy_epoch > 4294967295
    || typeof policy.created_at !== "string"
    || !policy.created_at.trim()
    || typeof policy.updated_at !== "string"
    || !policy.updated_at.trim()) {
    throw new Error("kcc20_regulated_demo_policy_ui_policy_invalid");
  }

  const normalizedPolicy = {
    schema_kind: policy.schema_kind,
    schema_version: policy.schema_version,
    network: policy.network,
    policy_epoch: policy.policy_epoch,
    regulated_asset_covenant_ids: demoPolicyArrayOrThrow(policy.regulated_asset_covenant_ids, "regulated_assets"),
    recipient_allowlist: demoPolicyArrayOrThrow(policy.recipient_allowlist, "allowlist"),
    recipient_blacklist: demoPolicyArrayOrThrow(policy.recipient_blacklist, "blacklist"),
    frozen_holders: demoPolicyArrayOrThrow(policy.frozen_holders, "frozen_holders"),
    frozen_outpoints: demoPolicyArrayOrThrow(policy.frozen_outpoints, "frozen_outpoints"),
    lawful_order_actions: demoPolicyArrayOrThrow(policy.lawful_order_actions, "lawful_order_actions"),
    created_at: policy.created_at,
    updated_at: policy.updated_at
  };
  if (normalizedPolicy.lawful_order_actions.length !== 0) {
    throw new Error("kcc20_regulated_demo_policy_ui_lawful_order_actions_not_supported_yet");
  }

  const sourceSnapshotId = String(data.source_policy_snapshot_id || "").trim().toLowerCase();
  const rulebookRoot = String(data.rulebook_root || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sourceSnapshotId)
    || !/^[0-9a-f]{64}$/.test(rulebookRoot)
    || String(data.canonical_rulebook_json_sha256 || "").trim().toLowerCase() !== rulebookRoot) {
    throw new Error("kcc20_regulated_demo_policy_ui_commitment_invalid");
  }

  const rulebook = data.rulebook;
  if (!rulebook || typeof rulebook !== "object"
    || rulebook.schema_kind !== "kcc20_regulated_rulebook_v1"
    || rulebook.schema_version !== 1
    || rulebook.network !== "testnet-10"
    || rulebook.policy_epoch !== normalizedPolicy.policy_epoch
    || String(rulebook.source_policy_snapshot_id || "").trim().toLowerCase() !== sourceSnapshotId) {
    throw new Error("kcc20_regulated_demo_policy_ui_rulebook_invalid");
  }
  const normalizedRulebook = {
    schema_kind: rulebook.schema_kind,
    schema_version: rulebook.schema_version,
    network: rulebook.network,
    policy_epoch: rulebook.policy_epoch,
    source_policy_snapshot_id: sourceSnapshotId,
    regulated_asset_covenant_ids: demoPolicyArrayOrThrow(rulebook.regulated_asset_covenant_ids, "rulebook_regulated_assets"),
    recipient_allowlist: demoPolicyArrayOrThrow(rulebook.recipient_allowlist, "rulebook_allowlist"),
    recipient_blacklist: demoPolicyArrayOrThrow(rulebook.recipient_blacklist, "rulebook_blacklist"),
    frozen_holders: demoPolicyArrayOrThrow(rulebook.frozen_holders, "rulebook_frozen_holders"),
    frozen_outpoints: demoPolicyArrayOrThrow(rulebook.frozen_outpoints, "rulebook_frozen_outpoints"),
    lawful_order_actions: demoPolicyArrayOrThrow(rulebook.lawful_order_actions, "rulebook_lawful_order_actions")
  };
  if (stableJson(demoPolicyContent(normalizedPolicy)) !== stableJson({
    regulated_asset_covenant_ids: normalizedRulebook.regulated_asset_covenant_ids,
    recipient_allowlist: normalizedRulebook.recipient_allowlist,
    recipient_blacklist: normalizedRulebook.recipient_blacklist,
    frozen_holders: normalizedRulebook.frozen_holders,
    frozen_outpoints: normalizedRulebook.frozen_outpoints,
    lawful_order_actions: normalizedRulebook.lawful_order_actions
  })) {
    throw new Error("kcc20_regulated_demo_policy_ui_policy_rulebook_mismatch");
  }

  return {
    policy: normalizedPolicy,
    rulebook: normalizedRulebook,
    sourceSnapshotId,
    rulebookRoot,
    operation: String(data.operation || "read").trim(),
    noOp: data.no_op === true,
    writesToDisk: data.writes_to_disk === true,
    registryPublicationRequired: data.registry_publication_required === true
      ? true
      : (data.registry_publication_required === false ? false : null)
  };
}

function demoPolicyRenderUnavailable(message) {
  demoPolicyState.policy = null;
  demoPolicyState.rulebook = null;
  demoPolicyState.sourceSnapshotId = "";
  demoPolicyState.rulebookRoot = "";
  demoPolicyState.registryPublicationRequired = null;
  demoPolicyClearRegistrySource();
  demoPolicySetStatus("failed", "Unavailable", message);
  setText("crDemoPolicyEpoch", "—");
  setText("crDemoPolicySnapshot", "—");
  setText("crDemoPolicyRoot", "—");
  setText("crDemoPolicyPublication", "Not evaluated");
  setText("crDemoPolicyUpdatedAt", "—");
  updateDemoPolicyButtons();
  renderControlContext();
}

function demoPolicyRenderMissing(message = "No saved Demo Policy exists for this user. Create one explicitly from the immutable Testnet-10 template.") {
  demoPolicyState.policy = null;
  demoPolicyState.rulebook = null;
  demoPolicyState.sourceSnapshotId = "";
  demoPolicyState.rulebookRoot = "";
  demoPolicyState.registryPublicationRequired = null;
  demoPolicyClearRegistrySource();
  demoPolicySetStatus("pending", "Not created", message);
  setText("crDemoPolicyEpoch", "—");
  setText("crDemoPolicySnapshot", "—");
  setText("crDemoPolicyRoot", "—");
  setText("crDemoPolicyPublication", "Not published");
  setText("crDemoPolicyUpdatedAt", "—");
  updateDemoPolicyButtons();
  renderControlContext();
}

function demoPolicyPopulateLab(value) {
  const policy = value.policy;
  const rulebook = value.rulebook;
  labState.activeRulebookRoot = value.rulebookRoot;
  labState.activeNetwork = "testnet-10";
  labState.activeSnapshot = value.sourceSnapshotId;
  if (byId("crLabNetwork")) byId("crLabNetwork").value = "testnet-10";
  if (byId("crLabSnapshot")) byId("crLabSnapshot").value = value.sourceSnapshotId;
  if (byId("crLabRegulatedAssets")) byId("crLabRegulatedAssets").value = policy.regulated_asset_covenant_ids.join("\n");
  if (byId("crLabAllowlist")) byId("crLabAllowlist").value = policy.recipient_allowlist.join("\n");
  if (byId("crLabBlacklist")) byId("crLabBlacklist").value = policy.recipient_blacklist.join("\n");
  if (byId("crLabFrozenHolders")) byId("crLabFrozenHolders").value = policy.frozen_holders.join("\n");
  if (byId("crLabFrozenOutpoints")) byId("crLabFrozenOutpoints").value = policy.frozen_outpoints.join("\n");
  if (byId("crLabLawfulActions")) byId("crLabLawfulActions").value = "[]";

  labState.rulebook = rulebook;
  labState.canonicalJson = stableJson(rulebook);
  labState.root = value.rulebookRoot;
  setText("crLabRoot", value.rulebookRoot);
  setText("crLabCanonicalJson", labState.canonicalJson);
  renderLabCounts(rulebook);
  setText("crLabCurrentRoot", labState.activeRulebookRoot || "Unavailable");
  setText("crLabRootComparison", value.rulebookRoot === labState.activeRulebookRoot
    ? "Matches saved Demo Policy root"
    : "Differs from saved Demo Policy root");
  if (byId("crLabExport")) byId("crLabExport").disabled = false;
}

function policyRegistryAuthoritativeFromDemoPolicy(value) {
  return {
    policy_source_mode: "Testnet-10 Local Demo Policy",
    local_demo_policy: true,
    network: "testnet-10",
    policy_epoch: value.policy.policy_epoch,
    source_policy_snapshot_id: value.sourceSnapshotId,
    rulebook_root: value.rulebookRoot
  };
}

function policyRegistryLiveMatchesAuthoritative() {
  const authoritative = policyRegistryDeployState.authoritative;
  const live = policyRegistryDeployState.liveRegistry;
  return !!authoritative
    && !!live
    && String(live.rulebook_root || "").trim().toLowerCase() === authoritative.rulebook_root
    && Number(live.policy_epoch) === authoritative.policy_epoch;
}

function syncPolicyRegistryTokenFields() {
  const authoritative = policyRegistryDeployState.authoritative;
  const liveMatches = policyRegistryLiveMatchesAuthoritative();
  const registryInput = byId("kcc20PolicyRegistryCovenantId");
  const epochInput = byId("kcc20PolicyEpoch");

  if (epochInput) {
    epochInput.value = authoritative ? String(authoritative.policy_epoch) : "";
  }
  if (registryInput) {
    registryInput.value = liveMatches
      ? String(policyRegistryDeployState.liveRegistry?.registry_covenant_id || "").trim().toLowerCase()
      : "";
  }

  if (liveMatches) {
    setText("crRegistryCovenantId", policyRegistryDeployState.liveRegistry.registry_covenant_id);
  } else if (policyRegistryDeployState.liveRegistry) {
    setText("crRegistryCovenantId", policyRegistryDeployState.liveRegistry.registry_covenant_id);
  } else {
    setText("crRegistryCovenantId", "Not deployed for this saved policy");
  }
}

function demoPolicySyncRegistrySource(value) {
  const previous = policyRegistryDeployState.authoritative;
  const next = policyRegistryAuthoritativeFromDemoPolicy(value);
  const sourceChanged = !!previous && (
    previous.policy_epoch !== next.policy_epoch
    || previous.rulebook_root !== next.rulebook_root
    || previous.source_policy_snapshot_id !== next.source_policy_snapshot_id
  );

  policyRegistryDeployState.authoritative = next;
  if (sourceChanged) {
    policyRegistryDeployState.build = null;
    policyRegistryDeployState.signedSafeJson = "";
  }
  syncPolicyRegistryTokenFields();
}

function demoPolicyClearRegistrySource() {
  policyRegistryDeployState.authoritative = null;
  policyRegistryDeployState.build = null;
  policyRegistryDeployState.signedSafeJson = "";
  policyRegistryDeployState.liveRegistry = null;
  policyRegistryDeployState.recoveryError = null;
  syncPolicyRegistryTokenFields();
  renderPolicyRegistryContext();
  updatePolicyRegistryButtons();
  renderControlContext();
}

function demoPolicyRenderResponse(data, messageOverride = "") {
  const value = demoPolicyResponseOrThrow(data);
  demoPolicyState.policy = value.policy;
  demoPolicyState.rulebook = value.rulebook;
  demoPolicyState.sourceSnapshotId = value.sourceSnapshotId;
  demoPolicyState.rulebookRoot = value.rulebookRoot;
  demoPolicyState.registryPublicationRequired = value.registryPublicationRequired;
  demoPolicySyncRegistrySource(value);

  let message = messageOverride;
  if (!message) {
    if (value.operation === "create") message = "Demo Policy created from the immutable Testnet-10 template.";
    else if (value.operation === "update" && value.noOp) message = "Calculated draft matches the saved Demo Policy; no file or epoch change was required.";
    else if (value.operation === "update") message = "Calculated draft saved as the next user-scoped Demo Policy epoch.";
    else if (value.operation === "reset" && value.noOp) message = "Saved Demo Policy already matches the requested template state.";
    else if (value.operation === "reset") message = "Saved Demo Policy reset to the immutable Testnet-10 template state.";
    else message = "Saved Demo Policy loaded for the authenticated user.";
  }

  demoPolicySetStatus("verified", "Saved", message);
  setText("crDemoPolicyMode", "Testnet-10 Local Demo Policy");
  setText("crDemoPolicyEpoch", value.policy.policy_epoch);
  setText("crDemoPolicySnapshot", value.sourceSnapshotId);
  setText("crDemoPolicyRoot", value.rulebookRoot);
  setText("crDemoPolicyUpdatedAt", new Date(value.policy.updated_at).toLocaleString());
  setText("crDemoPolicyPublication", value.registryPublicationRequired === true
    ? "Pending publication to a user-owned registry"
    : (value.registryPublicationRequired === false
      ? "No new publication required by this operation; live match not evaluated"
      : "Not evaluated — registry integration follows"));
  demoPolicyPopulateLab(value);
  renderPolicyRegistryContext();
  updatePolicyRegistryButtons();
  updateDemoPolicyButtons();
  renderControlContext();
  return value;
}

function demoPolicySetBusy(message) {
  demoPolicyState.busy = true;
  demoPolicySetStatus("loading", "Working…", message);
  updateDemoPolicyButtons();
}

function updateDemoPolicyButtons() {
  const ready = demoPolicyState.walletReady && !demoPolicyState.busy;
  const exists = !!demoPolicyState.policy;
  const calculatedDraft = !!labState?.rulebook && !!labState?.canonicalJson && /^[0-9a-f]{64}$/.test(String(labState?.root || ""));
  const includeWallet = byId("crDemoPolicyIncludeActiveWallet");
  if (includeWallet) includeWallet.disabled = !ready;
  const createButton = byId("crDemoPolicyCreateBtn");
  if (createButton) createButton.disabled = !ready || exists;
  const loadButton = byId("crDemoPolicyLoadBtn");
  if (loadButton) loadButton.disabled = !ready;
  const saveButton = byId("crDemoPolicySaveBtn");
  if (saveButton) saveButton.disabled = !ready || !exists || !calculatedDraft;
  const resetButton = byId("crDemoPolicyResetBtn");
  if (resetButton) resetButton.disabled = !ready || !exists;
  const exportButton = byId("crDemoPolicyExportBtn");
  if (exportButton) exportButton.disabled = !ready || !exists;
  updateControlControls();
}

async function demoPolicyJsonRequest(route, options = {}) {
  const response = await fetch(route, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    ...options
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function loadDemoPolicy({ announce = true } = {}) {
  if (!demoPolicyState.walletReady) {
    demoPolicyRenderUnavailable("A READY Testnet-10 wallet is required before loading a Demo Policy.");
    return;
  }
  demoPolicySetBusy(announce ? "Loading the saved user-scoped Demo Policy…" : "Checking for a saved Demo Policy…");
  try {
    const { response, data } = await demoPolicyJsonRequest(DEMO_POLICY_CURRENT_ROUTE, { method: "GET" });
    if (response.status === 404 && data?.reason === "kcc20_regulated_demo_policy_not_initialized") {
      demoPolicyRenderMissing();
      return;
    }
    if (!response.ok) {
      throw new Error(typeof data?.reason === "string" ? data.reason : `HTTP ${response.status}`);
    }
    demoPolicyRenderResponse(data);
  } catch (errorValue) {
    demoPolicyRenderUnavailable(`Demo Policy load failed: ${errorValue instanceof Error ? errorValue.message : "request_failed"}`);
  } finally {
    demoPolicyState.busy = false;
    updateDemoPolicyButtons();
  }
}

async function createDemoPolicy() {
  if (!demoPolicyState.walletReady || demoPolicyState.policy) return;
  demoPolicySetBusy("Creating the user-scoped Demo Policy from the immutable template…");
  try {
    const { response, data } = await demoPolicyJsonRequest(DEMO_POLICY_CREATE_ROUTE, {
      method: "POST",
      body: JSON.stringify({
        include_active_wallet_in_allowlist: byId("crDemoPolicyIncludeActiveWallet")?.checked === true
      })
    });
    if (!response.ok) throw new Error(typeof data?.reason === "string" ? data.reason : `HTTP ${response.status}`);
    demoPolicyRenderResponse(data);
  } catch (errorValue) {
    demoPolicySetStatus("failed", "Create failed", errorValue instanceof Error ? errorValue.message : "kcc20_regulated_demo_policy_create_failed");
  } finally {
    demoPolicyState.busy = false;
    updateDemoPolicyButtons();
  }
}

function demoPolicyDraftContentOrThrow() {
  if (!labState.rulebook || !labState.canonicalJson || !/^[0-9a-f]{64}$/.test(String(labState.root || ""))) {
    throw new Error("Calculate a valid Rulebook Lab draft before saving.");
  }
  return {
    regulated_asset_covenant_ids: [...labState.rulebook.regulated_asset_covenant_ids],
    recipient_allowlist: [...labState.rulebook.recipient_allowlist],
    recipient_blacklist: [...labState.rulebook.recipient_blacklist],
    frozen_holders: [...labState.rulebook.frozen_holders],
    frozen_outpoints: [...labState.rulebook.frozen_outpoints],
    lawful_order_actions: [...labState.rulebook.lawful_order_actions]
  };
}

async function saveDemoPolicyDraft() {
  if (!demoPolicyState.walletReady || !demoPolicyState.policy) return;
  demoPolicySetBusy("Saving the calculated draft through the user-scoped Demo Policy API…");
  try {
    const submittedPolicy = demoPolicyDraftContentOrThrow();
    const expectedRoot = labState.root;
    const { response, data } = await demoPolicyJsonRequest(DEMO_POLICY_UPDATE_ROUTE, {
      method: "POST",
      body: JSON.stringify({ policy: submittedPolicy })
    });
    if (!response.ok) throw new Error(typeof data?.reason === "string" ? data.reason : `HTTP ${response.status}`);
    const value = demoPolicyResponseOrThrow(data);
    if (stableJson(demoPolicyContent(value.policy)) !== stableJson(submittedPolicy)) {
      throw new Error("kcc20_regulated_demo_policy_ui_saved_content_mismatch");
    }
    if (value.rulebookRoot !== expectedRoot) {
      throw new Error("kcc20_regulated_demo_policy_ui_saved_root_mismatch");
    }
    demoPolicyRenderResponse(data);
  } catch (errorValue) {
    demoPolicySetStatus("failed", "Save failed", errorValue instanceof Error ? errorValue.message : "kcc20_regulated_demo_policy_save_failed");
  } finally {
    demoPolicyState.busy = false;
    updateDemoPolicyButtons();
  }
}

async function resetDemoPolicy() {
  if (!demoPolicyState.walletReady || !demoPolicyState.policy) return;
  if (!window.confirm("Reset this user's saved Testnet-10 Demo Policy to the immutable template? This may increment the policy epoch.")) return;
  demoPolicySetBusy("Resetting the saved Demo Policy to the immutable Testnet-10 template…");
  try {
    const { response, data } = await demoPolicyJsonRequest(DEMO_POLICY_RESET_ROUTE, {
      method: "POST",
      body: JSON.stringify({
        include_active_wallet_in_allowlist: byId("crDemoPolicyIncludeActiveWallet")?.checked === true
      })
    });
    if (!response.ok) throw new Error(typeof data?.reason === "string" ? data.reason : `HTTP ${response.status}`);
    demoPolicyRenderResponse(data);
  } catch (errorValue) {
    demoPolicySetStatus("failed", "Reset failed", errorValue instanceof Error ? errorValue.message : "kcc20_regulated_demo_policy_reset_failed");
  } finally {
    demoPolicyState.busy = false;
    updateDemoPolicyButtons();
  }
}

async function exportDemoPolicy() {
  if (!demoPolicyState.walletReady || !demoPolicyState.policy || demoPolicyState.busy) return;
  demoPolicySetBusy("Exporting the saved user-scoped Demo Policy…");
  try {
    const response = await fetch(DEMO_POLICY_EXPORT_ROUTE, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(typeof data?.reason === "string" ? data.reason : `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kcc20-regulated-demo-policy.v1.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    demoPolicySetStatus("verified", "Saved", "Saved Demo Policy exported. No policy, registry, token, or transaction state was changed.");
  } catch (errorValue) {
    demoPolicySetStatus("failed", "Export failed", errorValue instanceof Error ? errorValue.message : "kcc20_regulated_demo_policy_export_failed");
  } finally {
    demoPolicyState.busy = false;
    updateDemoPolicyButtons();
  }
}

const REGULATED_ISSUE_BUILD_ROUTE = "/api/covenants/issuer-token/issue/build";
const REGULATED_ISSUE_SUBMIT_ROUTE = "/api/covenants/issuer-token/issue/submit";
const REGULATED_ISSUE_MANUAL_AUTH_KIND = "kcc20_regulated_tn10_manual_test_authorization_v1";
const KEYRING_SESSION_KEY = "cw_keyring_session";

const issueDepositState = {
  walletReady: false,
  building: false,
  submitting: false,
  refreshingAssets: false,
  activeStatus: null,
  regulatedAssets: [],
  lastBuild: null,
  signedSafeJson: "",
  metadataLoading: false,
  metadataRequestSerial: 0,
  metadataAssetId: "",
  metadata: null
};

function normalizeRegulatedIssueProfile(token) {
  if (!token || token.regulated_profile_kind !== "KCC20-Regulated") return null;
  const profile = token.regulated_profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const pr = String(profile.pr || "").trim().toLowerCase();
  const pe = Number(profile.pe);
  const fc = Number(profile.fc);
  if (Number(profile.rg) !== 1 || Number(profile.rv) !== 1 || !/^[0-9a-f]{64}$/.test(pr)
    || !Number.isInteger(pe) || pe < 1 || pe > 4294967295
    || !Number.isInteger(fc) || fc < 1 || fc > 63) return null;
  return Object.freeze({ rg: 1, rv: 1, pr, pe, fc });
}

function shortIssueValue(value) {
  const text = String(value || "").trim();
  return text.length > 18 ? `${text.slice(0, 9)}…${text.slice(-7)}` : text;
}

function regulatedIssuerAssetsFromHoldings(holdings, activeAddress) {
  const tokens = holdings?.oma_l1 && Array.isArray(holdings.oma_l1.tokens) ? holdings.oma_l1.tokens : [];
  const byAsset = new Map();
  for (const token of tokens) {
    const assetId = String(token?.asset_covenant_id || "").trim().toLowerCase();
    const issuer = String(token?.issuer_identifier || "").trim();
    const profile = normalizeRegulatedIssueProfile(token);
    if (token?.asset_kind !== "oma_l1_covenant_token" || !/^[0-9a-f]{64}$/.test(assetId)
      || issuer !== activeAddress || !profile) continue;
    if (!byAsset.has(assetId)) {
      byAsset.set(assetId, Object.freeze({
        asset_covenant_id: assetId,
        token_symbol: String(token.token_symbol || "KCC20-Regulated").trim() || "KCC20-Regulated",
        token_name: String(token.token_name || "").trim(),
        decimals: Number.isInteger(token.decimals) ? token.decimals : 0,
        max_supply_raw: String(token.max_supply_raw || "0").trim(),
        issued_supply_raw: String(token.issued_supply_raw || "0").trim(),
        issuer_identifier: issuer,
        regulated_profile: profile,
        holder_script_profile: String(token.holder_script_profile || "owner_signature_v1").trim()
      }));
    }
  }
  return Array.from(byAsset.values()).sort((a, b) => a.token_symbol.localeCompare(b.token_symbol)
    || a.asset_covenant_id.localeCompare(b.asset_covenant_id));
}

function selectedRegulatedIssueAsset() {
  const value = String(byId("crIssueAssetSelect")?.value || "").trim().toLowerCase();
  return issueDepositState.regulatedAssets.find((asset) => asset.asset_covenant_id === value) || null;
}

function regulatedIssuePolicyStatus(asset) {
  if (!asset) return { ready: false, message: "Select an issuer-controlled KCC20-Regulated token." };
  const authoritative = policyRegistryDeployState.authoritative;
  const liveRegistry = policyRegistryDeployState.liveRegistry;
  if (!authoritative) return { ready: false, message: "Load the saved Demo Policy before Issue." };
  if (!liveRegistry || !policyRegistryLiveMatchesAuthoritative()) {
    return { ready: false, message: `Publish Demo Policy epoch ${authoritative.policy_epoch} to the Policy Registry before Issue.` };
  }
  if (!demoPolicyState.rulebook?.regulated_asset_covenant_ids?.includes(asset.asset_covenant_id)) {
    return { ready: false, message: "This token is not governed by the saved Demo Policy." };
  }
  if (asset.regulated_profile.pr !== String(liveRegistry.registry_covenant_id || "").trim().toLowerCase()) {
    return { ready: false, message: "The token references a different Policy Registry." };
  }
  return { ready: true, message: `Governed by live Demo Policy epoch ${authoritative.policy_epoch}; token profile began at epoch ${asset.regulated_profile.pe}.` };
}

function renderRegulatedIssueAssetSelection() {
  const asset = selectedRegulatedIssueAsset();
  const status = regulatedIssuePolicyStatus(asset);
  setText("crIssueAssetCovenantId", asset?.asset_covenant_id || "—");
  setText("crIssuePolicyRegistry", asset?.regulated_profile?.pr || "—");
  setText("crIssuePolicyStatus", status.message);
  updateRegulatedIssueControls();
}


function tokenMetadataSetStatus(state, label, message) {
  const badge = byId("crTokenMetadataStatusBadge");
  if (badge) {
    badge.dataset.state = state;
    badge.textContent = label;
  }
  setText("crTokenMetadataStatus", message);
}

function tokenMetadataAmountText(humanValue, rawValue) {
  const human = String(humanValue ?? "").trim();
  const raw = String(rawValue ?? "").trim();
  if (human && raw) return `${human} (${raw} raw)`;
  if (raw) return `${raw} raw`;
  return human || "—";
}

function tokenMetadataBooleanText(value, trueLabel, falseLabel) {
  return value === true ? trueLabel : falseLabel;
}

function clearTokenMetadata(message = "Select an issuer-controlled KCC20-Regulated token above.") {
  issueDepositState.metadataRequestSerial += 1;
  issueDepositState.metadataLoading = false;
  issueDepositState.metadataAssetId = "";
  issueDepositState.metadata = null;
  const content = byId("crTokenMetadataContent");
  if (content) content.hidden = true;
  tokenMetadataSetStatus("loading", "Waiting for token selection", message);
  [
    "crMetaTokenName", "crMetaTokenSymbol", "crMetaAssetCovenantId", "crMetaNetwork", "crMetaDecimals",
    "crMetaIssuer", "crMetaIssuedSupply", "crMetaMaxSupply", "crMetaRemainingSupply", "crMetaPendingBurnAmount",
    "crMetaProjectedSupply", "crMetaControllerAddress", "crMetaControllerOutpoint", "crMetaControllerCarrier",
    "crMetaControllerSchema", "crMetaControllerVerification", "crMetaRegistryCovenantId", "crMetaRegistryOutpoint",
    "crMetaRegistryAuthority", "crMetaRegistryPolicyStatus", "crMetaTokenProfileEpoch", "crMetaCurrentPolicyEpoch",
    "crMetaRulebookRoot", "crMetaPolicySnapshot", "crMetaGovernanceStatus", "crMetaControlFlags",
    "crMetaControlCapabilities", "crMetaPendingBurnCount", "crMetaPendingSupplyStatus"
  ].forEach((id) => setText(id, "—"));
  setText("crMetaPendingSupplyActions", "No pending supply actions.");
  setText("crMetaTechnicalJson", "");
  updateTokenMetadataControls();
}

function updateTokenMetadataControls() {
  const asset = selectedRegulatedIssueAsset();
  const transactionBusy = issueDepositState.building || issueDepositState.submitting || issueDepositState.refreshingAssets;
  const button = byId("crTokenMetadataRefreshBtn");
  if (button) {
    button.disabled = !issueDepositState.walletReady || !asset || issueDepositState.metadataLoading || transactionBusy;
    button.textContent = issueDepositState.metadataLoading ? "Refreshing Metadata…" : "Refresh Metadata";
    button.title = asset
      ? "Reload live controller, supply, Registry, policy, controls, and pending supply actions."
      : "Select an issuer-controlled KCC20-Regulated token first.";
  }
}

function tokenMetadataResponseOrThrow(data, expectedAssetId) {
  const assetId = String(data?.identity?.asset_covenant_id || "").trim().toLowerCase();
  if (data?.ok !== true
    || data.proof_kind !== "kcc20_regulated_token_metadata_v1"
    || data.application_status !== "kcc20_regulated_token_metadata_live_verified_tn10"
    || assetId !== expectedAssetId
    || !data.identity || typeof data.identity !== "object" || Array.isArray(data.identity)
    || !data.supply || typeof data.supply !== "object" || Array.isArray(data.supply)
    || !data.controller || typeof data.controller !== "object" || Array.isArray(data.controller)
    || !data.registry_and_policy || typeof data.registry_and_policy !== "object" || Array.isArray(data.registry_and_policy)
    || !data.controls || typeof data.controls !== "object" || Array.isArray(data.controls)
    || !data.pending_supply_actions || typeof data.pending_supply_actions !== "object" || Array.isArray(data.pending_supply_actions)
    || !data.technical_metadata || typeof data.technical_metadata !== "object" || Array.isArray(data.technical_metadata)
    || data.signing_enabled !== false || data.broadcasting_enabled !== false || data.minting_enabled !== false) {
    throw new Error("kcc20_regulated_token_metadata_response_invalid");
  }
  return data;
}

function renderTokenMetadata(data) {
  const identity = data.identity;
  const supply = data.supply;
  const controller = data.controller;
  const registry = data.registry_and_policy;
  const controls = data.controls;
  const pending = data.pending_supply_actions;
  const pendingRecords = Array.isArray(pending.records) ? pending.records : [];
  const pendingCount = Number.isInteger(pending.count) ? pending.count : pendingRecords.length;

  setText("crMetaTokenName", identity.token_name || "Unnamed token");
  setText("crMetaTokenSymbol", identity.token_symbol || "—");
  setText("crMetaAssetCovenantId", identity.asset_covenant_id || "—");
  setText("crMetaNetwork", data.networkId || "—");
  setText("crMetaDecimals", identity.decimals ?? "—");
  setText("crMetaIssuer", identity.issuer_identifier || "—");
  setText("crMetaIssuedSupply", tokenMetadataAmountText(supply.issued_supply_human, supply.issued_supply_raw));
  setText("crMetaMaxSupply", tokenMetadataAmountText(supply.max_supply_human, supply.max_supply_raw));
  setText("crMetaRemainingSupply", tokenMetadataAmountText(supply.remaining_issuable_human, supply.remaining_issuable_raw));
  setText("crMetaPendingBurnAmount", tokenMetadataAmountText(supply.pending_burn_amount_human, supply.pending_burn_amount_raw));
  setText("crMetaProjectedSupply", supply.projected_issued_supply_raw == null
    ? "Unavailable — pending burns exceed controller-issued supply"
    : tokenMetadataAmountText(supply.projected_issued_supply_human, supply.projected_issued_supply_raw));

  setText("crMetaControllerAddress", controller.address || "—");
  setText("crMetaControllerOutpoint", controller.outpoint || "—");
  setText("crMetaControllerCarrier", controller.carrier_kas != null
    ? `${controller.carrier_kas} KAS${controller.carrier_sompi != null ? ` (${controller.carrier_sompi} sompi)` : ""}`
    : (controller.carrier_sompi != null ? `${controller.carrier_sompi} sompi` : "—"));
  setText("crMetaControllerSchema", controller.state_schema || "—");
  setText("crMetaControllerVerification", [controller.live_verification_status, controller.verification_rule].filter(Boolean).join(" · ") || "—");

  setText("crMetaRegistryCovenantId", registry.registry_covenant_id || "—");
  setText("crMetaRegistryOutpoint", registry.registry_outpoint || "—");
  setText("crMetaRegistryAuthority", registry.registry_authority_address || "—");
  const registryStatusParts = [
    tokenMetadataBooleanText(registry.registry_record_found, "Registry record found", "Registry record missing"),
    tokenMetadataBooleanText(registry.registry_live_verified, "live verified", registry.registry_live_reason || "live verification unavailable"),
    tokenMetadataBooleanText(registry.registry_matches_current_policy, "matches current policy", "does not match current policy")
  ];
  setText("crMetaRegistryPolicyStatus", registryStatusParts.join(" · "));

  setText("crMetaTokenProfileEpoch", registry.token_profile_epoch ?? "—");
  setText("crMetaCurrentPolicyEpoch", registry.current_policy_epoch ?? "—");
  setText("crMetaRulebookRoot", registry.current_rulebook_root || registry.registry_rulebook_root || "—");
  setText("crMetaPolicySnapshot", registry.source_policy_snapshot_id || "—");
  const governanceReady = registry.token_is_governed_by_current_policy === true
    && registry.token_profile_epoch_compatible === true
    && registry.registry_matches_current_policy === true;
  setText("crMetaGovernanceStatus", governanceReady
    ? "Current — token, profile epoch, Registry, and saved Demo Policy agree"
    : [
      registry.token_is_governed_by_current_policy === true ? "token governed" : "token not governed by current policy",
      registry.token_profile_epoch_compatible === true ? "profile epoch compatible" : "profile epoch incompatible",
      registry.registry_matches_current_policy === true ? "Registry current" : "Registry/policy mismatch"
    ].join(" · "));

  const rawFlags = Number(controls.control_flags_raw);
  setText("crMetaControlFlags", Number.isInteger(rawFlags) ? `${rawFlags} (0b${rawFlags.toString(2).padStart(6, "0")})` : "—");
  const capabilityLabels = [
    ["rulebook_transfer_required", "Rulebook-gated transfer"],
    ["freeze_supported", "Freeze / unfreeze"],
    ["seize_supported", "Seizure"],
    ["forced_burn_supported", "Forced burn"],
    ["recipient_allowlist_enabled", "Recipient allowlist"],
    ["recipient_blacklist_enabled", "Recipient blacklist"]
  ];
  const enabledCapabilities = capabilityLabels.filter(([key]) => controls[key] === true).map(([, label]) => label);
  setText("crMetaControlCapabilities", enabledCapabilities.length ? enabledCapabilities.join(" · ") : "No regulated controls enabled");

  setText("crMetaPendingBurnCount", pendingCount);
  if (pendingCount > 0 && supply.pending_burn_consistent_with_issued_supply === true) {
    setText("crMetaPendingSupplyStatus", `Pending — ${pendingCount} burn receipt${pendingCount === 1 ? "" : "s"} awaits controller-supply accounting.`);
  } else if (pendingCount > 0) {
    setText("crMetaPendingSupplyStatus", "Attention — pending burn receipts are inconsistent with controller-issued supply.");
  } else {
    setText("crMetaPendingSupplyStatus", "Current — no pending controller-supply adjustments.");
  }
  setText("crMetaPendingSupplyActions", pendingCount > 0
    ? JSON.stringify(pendingRecords, null, 2)
    : "No pending supply actions.");
  setText("crMetaTechnicalJson", JSON.stringify(data, null, 2));

  const content = byId("crTokenMetadataContent");
  if (content) content.hidden = false;
  if (pendingCount > 0) {
    tokenMetadataSetStatus(
      "pending",
      "Live · Supply update pending",
      `Live metadata verified. ${pendingCount} burn receipt${pendingCount === 1 ? "" : "s"} totaling ${tokenMetadataAmountText(supply.pending_burn_amount_human, supply.pending_burn_amount_raw)} awaits controller-supply accounting.`
    );
  } else if (!governanceReady) {
    tokenMetadataSetStatus("pending", "Live · Governance attention", "Live metadata verified, but the token, Registry, or current Demo Policy requires attention.");
  } else {
    tokenMetadataSetStatus("verified", "Live verified", "Current controller, supply, Registry, policy, controls, and pending supply state are live-verified.");
  }
}

async function loadSelectedTokenMetadata({ announce = true } = {}) {
  const asset = selectedRegulatedIssueAsset();
  if (!issueDepositState.walletReady || !asset) {
    clearTokenMetadata(issueDepositState.walletReady
      ? "Select an issuer-controlled KCC20-Regulated token above."
      : "A READY Testnet-10 issuer wallet is required.");
    return null;
  }

  const assetId = asset.asset_covenant_id;
  const requestSerial = ++issueDepositState.metadataRequestSerial;
  issueDepositState.metadataLoading = true;
  issueDepositState.metadataAssetId = assetId;
  issueDepositState.metadata = null;
  const content = byId("crTokenMetadataContent");
  if (content) content.hidden = true;
  tokenMetadataSetStatus("loading", "Loading live metadata", announce
    ? `Loading live controller, supply, Registry, policy, and pending supply data for ${asset.token_symbol}…`
    : "Refreshing live token metadata…");
  updateTokenMetadataControls();

  try {
    const response = await fetch(`${REGULATED_TOKEN_METADATA_ROUTE}?asset_covenant_id=${encodeURIComponent(assetId)}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    const responseData = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = String(responseData?.error || responseData?.reason || `HTTP ${response.status}`).trim();
      throw new Error(reason || `HTTP ${response.status}`);
    }
    const data = tokenMetadataResponseOrThrow(responseData, assetId);
    if (requestSerial !== issueDepositState.metadataRequestSerial
      || selectedRegulatedIssueAsset()?.asset_covenant_id !== assetId) return null;
    issueDepositState.metadata = data;
    renderTokenMetadata(data);
    return data;
  } catch (errorValue) {
    if (requestSerial !== issueDepositState.metadataRequestSerial) return null;
    issueDepositState.metadata = null;
    const failedContent = byId("crTokenMetadataContent");
    if (failedContent) failedContent.hidden = true;
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_token_metadata_load_failed";
    tokenMetadataSetStatus("failed", "Metadata unavailable", `Token metadata could not be loaded: ${reason}`);
    return null;
  } finally {
    if (requestSerial === issueDepositState.metadataRequestSerial) {
      issueDepositState.metadataLoading = false;
      updateTokenMetadataControls();
    }
  }
}

function populateRegulatedIssueAssets(preferredAssetId = "") {
  const select = byId("crIssueAssetSelect");
  if (!select) return;
  const preferred = String(preferredAssetId || "").trim().toLowerCase();
  const previous = String(select.value || "").trim().toLowerCase();
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = issueDepositState.regulatedAssets.length
    ? "Select issuer-controlled KCC20-Regulated token"
    : "No issuer-controlled KCC20-Regulated controller found";
  select.appendChild(empty);
  for (const asset of issueDepositState.regulatedAssets) {
    const option = document.createElement("option");
    option.value = asset.asset_covenant_id;
    option.textContent = `${asset.token_symbol} · ${shortIssueValue(asset.asset_covenant_id)} · profile epoch ${asset.regulated_profile.pe}`;
    select.appendChild(option);
  }
  if (preferred && issueDepositState.regulatedAssets.some((asset) => asset.asset_covenant_id === preferred)) select.value = preferred;
  else if (previous && issueDepositState.regulatedAssets.some((asset) => asset.asset_covenant_id === previous)) select.value = previous;
  else if (issueDepositState.regulatedAssets.length === 1) select.value = issueDepositState.regulatedAssets[0].asset_covenant_id;
  renderRegulatedIssueAssetSelection();
  updateTokenMetadataControls();
  populateSeizeAssets(preferred);
  populateForcedBurnAssets(preferred);
}

function issueRawAmountOrThrow() {
  const value = String(byId("crIssueAmountRaw")?.value || "").trim();
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("issue_amount_raw_must_be_positive");
  return value;
}

function issueCarrierIsValid() {
  const value = String(byId("crIssueHolderCarrierKas")?.value || "").trim();
  return /^\d+(\.\d{1,8})?$/.test(value) && Number(value) > 0;
}

function updateRegulatedIssueControls() {
  const asset = selectedRegulatedIssueAsset();
  const policyStatus = regulatedIssuePolicyStatus(asset);
  const busy = issueDepositState.building || issueDepositState.submitting || issueDepositState.refreshingAssets;
  const select = byId("crIssueAssetSelect");
  if (select) select.disabled = !issueDepositState.walletReady || !issueDepositState.regulatedAssets.length || busy;
  ["crIssueAmountRaw", "crIssueRecipientAddress", "crIssueHolderCarrierKas"].forEach((id) => {
    const element = byId(id);
    if (element) element.disabled = !issueDepositState.walletReady || !asset || busy;
  });
  const button = byId("crIssueBuildBtn");
  if (button) {
    let amountValid = false;
    try { issueRawAmountOrThrow(); amountValid = true; } catch { amountValid = false; }
    const recipient = String(byId("crIssueRecipientAddress")?.value || "").trim();
    button.disabled = busy || !issueDepositState.walletReady || !asset || !policyStatus.ready || !amountValid || !recipient || !issueCarrierIsValid();
    button.textContent = busy ? "Issuing Regulated Tokens…" : "Issue Regulated Tokens";
    button.title = button.disabled ? (policyStatus.ready ? "Complete the Issue fields." : policyStatus.message)
      : "Build, sign locally, submit, verify, and track this Testnet-10 Issue transaction.";
  }
  updateTokenMetadataControls();
}

function setIssueDepositInputsEnabled() { updateRegulatedIssueControls(); }

function clearIssueBuildProof() {
  issueDepositState.lastBuild = null;
  issueDepositState.signedSafeJson = "";
  const proof = byId("crIssueBuildProof");
  if (proof) proof.textContent = "";
  const wrap = byId("crIssueBuildProofWrap");
  if (wrap) wrap.hidden = true;
}

function clearIssueDepositVerification(message) {
  clearIssueBuildProof();
  setText("crIssueAuthorizationStatus", message);
  updateRegulatedIssueControls();
}

function renderRegulatedIssueProof(value) {
  const proof = byId("crIssueBuildProof");
  if (proof) proof.textContent = JSON.stringify(value, null, 2);
  const wrap = byId("crIssueBuildProofWrap");
  if (wrap) wrap.hidden = false;
}

function kasToSompiString(value, fieldName) {
  const text = String(value || "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error(`${fieldName}_kas_invalid`);
  const [wholeRaw, fractionalRaw = ""] = text.split(".");
  const sompi = (BigInt(wholeRaw || "0") * 100000000n) + BigInt((fractionalRaw + "00000000").slice(0, 8));
  if (sompi <= 0n) throw new Error(`${fieldName}_kas_must_be_positive`);
  return sompi.toString();
}

async function activeIssueKeyringOrThrow(statusOverride = null) {
  const status = statusOverride || issueDepositState.activeStatus;
  if (!status || status.ok !== true) throw new Error("active_wallet_required");
  const raw = window.sessionStorage?.getItem(KEYRING_SESSION_KEY);
  if (!raw) throw new Error("wallet_locked");
  const session = JSON.parse(raw);
  const privateKeyHex = String(session?.priv0_hex || "").trim();
  if (Number(session?.v || 0) !== 1 || !/^[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error("wallet_locked");
  if (String(session.wallet_id || "").trim() !== String(status.wallet_id || "").trim()) throw new Error("wallet_locked");
  if (String(session.wallet_type || "").trim() !== String(status.wallet_type || "").trim()) throw new Error("wallet_locked");
  if (window.kaspaReady && typeof window.kaspaReady.then === "function") await window.kaspaReady;
  if (!window.kaspa) throw new Error("kaspa_sdk_not_loaded");
  const privateKey = new window.kaspa.PrivateKey(privateKeyHex);
  const networkMeta = window.CwNetworkShared?.getNetworkMeta(status.network || "");
  const walletNetworkLabel = String(networkMeta?.walletNetworkLabel || "").trim();
  if (!walletNetworkLabel || privateKey.toAddress(walletNetworkLabel).toString() !== String(status.address0 || "")) throw new Error("wallet_locked");
  return Object.freeze({ owner_public_key: privateKey.toPublicKey().toString(), address0: String(status.address0 || ""), privateKey });
}

function fillIssueSignatureScript(tx, inputIndex, signatureScript, reason) {
  const inputs = tx && Array.isArray(tx.inputs) ? tx.inputs : [];
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || !inputs[inputIndex]) throw new Error(reason);
  inputs[inputIndex].signatureScript = signatureScript;
  tx.inputs = inputs;
}

async function signRegulatedIssueBuild(build, keyring) {
  const txSafeJson = String(build?.txToSignSafeJson || "").trim();
  const signCtx = build?.signing_context_public;
  if (!txSafeJson || !signCtx || typeof signCtx !== "object") throw new Error("regulated_issue_unsigned_build_missing");

  const controllerInputIndex = Number(signCtx.controller_input_index);
  const fundingInputIndexes = Array.isArray(signCtx.native_kas_funding_input_indexes)
    ? signCtx.native_kas_funding_input_indexes.map((value) => Number(value))
    : [];
  const fundingInputOutpoints = Array.isArray(signCtx.native_kas_funding_input_outpoints)
    ? signCtx.native_kas_funding_input_outpoints.map((value) => String(value || "").trim())
    : [];
  const nativeFundingInputs = Array.isArray(build.native_kas_funding_inputs)
    ? build.native_kas_funding_inputs
    : [];
  const signIndexes = Array.isArray(build.signInputIndexes)
    ? build.signInputIndexes.map((value) => Number(value))
    : [];

  if (!Number.isInteger(controllerInputIndex) || controllerInputIndex < 0) {
    throw new Error("regulated_issue_controller_input_not_signable");
  }
  if (!fundingInputIndexes.length
    || fundingInputIndexes.some((index) => !Number.isInteger(index) || index < 0 || index === controllerInputIndex)
    || new Set(fundingInputIndexes).size !== fundingInputIndexes.length) {
    throw new Error("regulated_issue_funding_indexes_invalid");
  }
  const expectedSignIndexes = [controllerInputIndex, ...fundingInputIndexes];
  if (signIndexes.length !== expectedSignIndexes.length
    || signIndexes.some((index, position) => index !== expectedSignIndexes[position])) {
    throw new Error("regulated_issue_sign_indexes_invalid");
  }
  if (nativeFundingInputs.length !== fundingInputIndexes.length
    || fundingInputOutpoints.length !== fundingInputIndexes.length) {
    throw new Error("regulated_issue_funding_plan_invalid");
  }
  for (let position = 0; position < fundingInputIndexes.length; position += 1) {
    const input = nativeFundingInputs[position];
    if (!input
      || Number(input.input_index) !== fundingInputIndexes[position]
      || String(input.outpoint || "").trim() !== fundingInputOutpoints[position]
      || input.normal_kas_input !== true) {
      throw new Error("regulated_issue_funding_plan_mismatch");
    }
  }

  const redeemScriptHex = String(signCtx.source_controller_redeem_script_hex || "").trim();
  if (!/^[0-9a-f]+$/i.test(redeemScriptHex) || redeemScriptHex.length % 2 !== 0) {
    throw new Error("regulated_issue_controller_redeem_script_missing");
  }

  const k = window.kaspa;
  const tx = k.Transaction.deserializeFromSafeJSON(txSafeJson);
  const inputs = tx && Array.isArray(tx.inputs) ? tx.inputs : [];
  if (!inputs[controllerInputIndex] || fundingInputIndexes.some((index) => !inputs[index])) {
    throw new Error("regulated_issue_signing_input_missing");
  }

  const script = k.ScriptBuilder.fromScript(redeemScriptHex);
  const dummySignature = new Uint8Array(65);
  fillIssueSignatureScript(tx, controllerInputIndex, script.encodePayToScriptHashSignatureScript(dummySignature), "regulated_issue_controller_input_missing");
  const controllerSignature = k.createInputSignature(tx, controllerInputIndex, keyring.privateKey, null);
  fillIssueSignatureScript(tx, controllerInputIndex, script.encodePayToScriptHashSignatureScript(controllerSignature), "regulated_issue_controller_input_missing");

  for (const fundingInputIndex of fundingInputIndexes) {
    const fundingSignature = k.createInputSignature(tx, fundingInputIndex, keyring.privateKey, null);
    fillIssueSignatureScript(tx, fundingInputIndex, fundingSignature, "regulated_issue_funding_input_missing");
  }

  tx.finalize();
  const signedSafeJson = tx.serializeToSafeJSON();
  k.Transaction.deserializeFromSafeJSON(signedSafeJson);
  return signedSafeJson;
}

async function issueRegulatedTokensOneClick() {
  if (issueDepositState.building || issueDepositState.submitting) return;
  const asset = selectedRegulatedIssueAsset();
  const policyStatus = regulatedIssuePolicyStatus(asset);
  if (!asset) throw new Error("kcc20_regulated_issue_asset_required");
  if (!policyStatus.ready) throw new Error("kcc20_regulated_issue_policy_registry_not_ready");
  const amountRaw = issueRawAmountOrThrow();
  const recipient = String(byId("crIssueRecipientAddress")?.value || "").trim();
  if (!recipient) throw new Error("kcc20_regulated_issue_recipient_required");
  if (!issueCarrierIsValid()) throw new Error("issue_holder_carrier_kas_invalid");
  const confirmed = window.confirm(`Issue ${amountRaw} raw ${asset.token_symbol} to:\n${recipient}\n\nThis will sign locally and submit a real Testnet-10 transaction.`);
  if (!confirmed) return;

  issueDepositState.building = true;
  clearIssueBuildProof();
  setText("crIssueAuthorizationStatus", "Creating the demo authorization and building the Issue transaction…");
  updateRegulatedIssueControls();
  try {
    const keyring = await activeIssueKeyringOrThrow();
    const buildResponse = await fetch(REGULATED_ISSUE_BUILD_ROUTE, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_covenant_id: asset.asset_covenant_id,
        issue_amount_raw: amountRaw,
        recipient_address: recipient,
        owner_public_key: keyring.owner_public_key,
        holder_carrier_sompi: kasToSompiString(byId("crIssueHolderCarrierKas")?.value || "1", "issue_holder_carrier"),
        fee_reserve_sompi: kasToSompiString(byId("crIssueFeeReserveKas")?.value || "0.01", "issue_fee_reserve"),
        regulated_issue_test_authorization: {
          authorization_kind: REGULATED_ISSUE_MANUAL_AUTH_KIND,
          amount_raw: amountRaw,
          acknowledge_synthetic_test_authorization: true
        }
      })
    });
    const build = await buildResponse.json().catch(() => null);
    if (!buildResponse.ok || build?.ok !== true) throw new Error(String(build?.reason || `HTTP ${buildResponse.status}`));
    if (build.issue_build_kind !== "oma_l1_issue_holder_build_v1"
      || build.application_status !== "regulated_issue_build_ready_for_local_sign_submit_tn10"
      || build.regulated_issue !== true
      || String(build.asset_covenant_id || "").toLowerCase() !== asset.asset_covenant_id
      || String(build.token_definition?.issue_amount_raw || "") !== amountRaw
      || build.submit_route !== REGULATED_ISSUE_SUBMIT_ROUTE
      || typeof build.submit_token !== "string" || !build.submit_token
      || build.submit_route_enabled !== true
      || !Array.isArray(build.signInputIndexes) || build.signInputIndexes.length < 2
      || build.safety?.regulated_issue_tn10_submit_enabled !== true) {
      throw new Error("kcc20_regulated_issue_build_response_invalid");
    }
    issueDepositState.lastBuild = build;
    setText("crIssueAuthorizationStatus", "Issue transaction built. Signing locally…");
    const signedSafeJson = await signRegulatedIssueBuild(build, keyring);
    issueDepositState.signedSafeJson = signedSafeJson;
    issueDepositState.building = false;
    issueDepositState.submitting = true;
    updateRegulatedIssueControls();
    setText("crIssueAuthorizationStatus", "Submitting the regulated Issue transaction to Testnet-10…");
    const submitResponse = await fetch(REGULATED_ISSUE_SUBMIT_ROUTE, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ submit_intent: "submit_oma_l1_issue_holder_v1", submit_token: build.submit_token, signedSafeJson })
    });
    const submit = await submitResponse.json().catch(() => null);
    if (!submitResponse.ok || submit?.ok !== true) throw new Error(String(submit?.reason || `HTTP ${submitResponse.status}`));
    renderRegulatedIssueProof({
      proof_kind: "kcc20_regulated_tn10_issue_one_click_v1",
      application_status: submit.application_status,
      asset_covenant_id: submit.asset_covenant_id,
      token_symbol: asset.token_symbol,
      amount_raw: amountRaw,
      recipient_address: recipient,
      submitted_txid: submit.submitted_txid,
      post_submit_scan_status: submit.post_submit_scan?.status || submit.post_submit_scan_status || null,
      tracked_asset_status: submit.tracked_asset?.tracking_status || submit.tracked_asset_status || null,
      authorization_consumed: submit.regulated_issue_authorization_consumption?.record_written === true
        || submit.regulated_issue_authorization_consumption?.status === "consumed",
      signed_transaction_json_echoed: false,
      signature_script_echoed: false
    });
    setText("crIssueAuthorizationStatus", "Issue complete. Inspector and Holdings can now refresh from the live Testnet-10 outputs.");
    await refreshRegulatedIssueAssets(asset.asset_covenant_id);
    window.dispatchEvent(new CustomEvent("cw:kcc20-regulated-issue-complete", {
      detail: { asset_covenant_id: asset.asset_covenant_id, submitted_txid: submit.submitted_txid }
    }));
  } catch (errorValue) {
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_issue_failed";
    renderRegulatedIssueProof({ ok: false, reason });
    setText("crIssueAuthorizationStatus", `Regulated Issue failed: ${reason}`);
  } finally {
    issueDepositState.building = false;
    issueDepositState.submitting = false;
    updateRegulatedIssueControls();
  }
}

function invalidateIssueBuildProof() {
  clearIssueBuildProof();
  renderRegulatedIssueAssetSelection();
  updateRegulatedIssueControls();
}

function policyRegistryKasToSompi(value, fieldName) {
  const text = String(value || "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error(`${fieldName}_kas_invalid`);
  const [wholeRaw, fractionalRaw = ""] = text.split(".");
  const sompi = (BigInt(wholeRaw || "0") * 100000000n) + BigInt((fractionalRaw + "00000000").slice(0, 8));
  if (sompi <= 0n) throw new Error(`${fieldName}_kas_must_be_positive`);
  return sompi.toString();
}

function policyRegistryReadinessReason() {
  if (!policyRegistryDeployState.walletReady) {
    return "A READY Testnet-10 wallet is required.";
  }
  const authoritative = policyRegistryDeployState.authoritative;
  if (!authoritative) {
    return "Load and save the Demo Policy before deploying its registry.";
  }
  if (authoritative.network !== "testnet-10") {
    return "The saved policy must be a Testnet-10 Demo Policy.";
  }
  if (!/^[0-9a-f]{64}$/.test(String(authoritative.rulebook_root || ""))) {
    return "The saved Demo Policy rulebook root is invalid.";
  }
  if (policyRegistryLiveMatchesAuthoritative()) {
    return `Registry is live for saved Demo Policy epoch ${authoritative.policy_epoch}.`;
  }
  if (policyRegistryDeployState.liveRegistry) {
    return `The known registry does not match saved Demo Policy epoch ${authoritative.policy_epoch}; a registry update is required.`;
  }
  if (policyRegistryDeployState.submitting) {
    return "Registry submission is in progress.";
  }
  return "";
}

function renderPolicyRegistryContext() {
  const status = policyRegistryDeployState.activeStatus;
  const authoritative = policyRegistryDeployState.authoritative;
  const liveMatches = policyRegistryLiveMatchesAuthoritative();

  setText("crRegistryRulebookRoot", authoritative?.rulebook_root || "Load Demo Policy to view its saved root.");
  if (!authoritative) {
    setText("crRegistryRulebookMeta", "Load and save the Demo Policy before deploying its registry.");
  } else if (liveMatches) {
    setText("crRegistryRulebookMeta", `Live registry matches saved Demo Policy epoch ${authoritative.policy_epoch}. Token Deploy fields are filled automatically.`);
  } else if (policyRegistryDeployState.liveRegistry) {
    setText("crRegistryRulebookMeta", `Saved Demo Policy epoch ${authoritative.policy_epoch} differs from the known registry. Publish a registry update before deploying or issuing a governed token.`);
  } else {
    setText("crRegistryRulebookMeta", `Saved Demo Policy epoch ${authoritative.policy_epoch} is ready. Build or recover its user-owned Testnet-10 registry.`);
  }
  const authority = policyRegistryAuthorityState();
  setText("crRegistryAuthority", authority.authorityAddress || status?.address0 || "Waiting for READY Testnet-10 wallet…");
  syncPolicyRegistryTokenFields();
}

function updatePolicyRegistryButtons() {
  const authoritative = policyRegistryDeployState.authoritative;
  const liveMatches = policyRegistryLiveMatchesAuthoritative();
  const busy = policyRegistryDeployState.orchestrating || policyRegistryDeployState.submitting || policyRegistryDeployState.recovering;
  const authority = policyRegistryAuthorityState();
  const publicationAuthorityReady = !policyRegistryDeployState.liveRegistry || authority.activeWalletIsAuthority;
  const ready = policyRegistryDeployState.walletReady
    && authoritative?.network === "testnet-10"
    && /^[0-9a-f]{64}$/.test(String(authoritative?.rulebook_root || ""))
    && !liveMatches
    && publicationAuthorityReady;
  const deployBtn = byId("crRegistryBuildBtn");
  const signBtn = byId("crRegistrySignBtn");
  const submitBtn = byId("crRegistrySubmitBtn");
  const readinessReason = policyRegistryReadinessReason();

  if (deployBtn) {
    const updating = !!policyRegistryDeployState.liveRegistry && !liveMatches;
    deployBtn.textContent = liveMatches
      ? "Policy Registry Live"
      : (busy ? (updating ? "Updating Policy Registry…" : "Deploying Policy Registry…")
        : (updating ? "Publish Registry Update" : "Deploy Policy Registry"));
    deployBtn.disabled = !ready || busy;
    deployBtn.title = deployBtn.disabled
      ? ((!publicationAuthorityReady && authority.authorityAddress)
        ? `Select Registry authority wallet ${authority.authorityAddress} to publish this Registry update.`
        : (readinessReason || "Complete the current registry step first."))
      : "Build, sign locally, submit, and verify the saved Demo Policy registry on Testnet-10.";
  }
  if (signBtn) {
    signBtn.hidden = true;
    signBtn.disabled = true;
    signBtn.setAttribute("aria-hidden", "true");
  }
  if (submitBtn) {
    submitBtn.hidden = true;
    submitBtn.disabled = true;
    submitBtn.setAttribute("aria-hidden", "true");
  }
  updateControlControls();
  if (!policyRegistryDeployState.build && !policyRegistryDeployState.signedSafeJson && !busy) {
    if (liveMatches) setText("crRegistryStatus", `Registry is live for saved Demo Policy epoch ${authoritative.policy_epoch}. Continue to Issue.`);
    else if (readinessReason) setText("crRegistryStatus", readinessReason);
    else if (authoritative) setText("crRegistryStatus", `Saved Demo Policy epoch ${authoritative.policy_epoch} is ready for Registry publication.`);
  }
}

function renderPolicyRegistryProof(value) {
  const wrap = byId("crRegistryProofWrap");
  const proof = byId("crRegistryProof");
  if (proof) proof.textContent = JSON.stringify(value, null, 2);
  if (wrap) wrap.hidden = false;
}

function acceptRecoveredPolicyRegistry(data, authoritative, { announce = true } = {}) {
  const covenantId = String(data?.registry_covenant_id || "").trim().toLowerCase();
  if (data?.build_kind !== "kcc20_policy_registry_existing_live_v1" || !/^[0-9a-f]{64}$/.test(covenantId)
    || typeof data?.active_wallet_is_registry_authority !== "boolean"
    || !String(data?.authority_address || "").trim()
    || data?.application_status !== "kcc20_policy_registry_existing_live_verified_tn10"
    || data?.policy_source_mode !== "Testnet-10 Local Demo Policy" || data?.local_demo_policy !== true
    || String(data?.rulebook_root || "") !== authoritative.rulebook_root
    || String(data?.source_policy_snapshot_id || "") !== authoritative.source_policy_snapshot_id
    || Number(data?.policy_epoch) !== authoritative.policy_epoch
    || data?.submit_token !== null || data?.submit_route !== null
    || !Array.isArray(data?.signInputIndexes) || data.signInputIndexes.length !== 0) {
    throw new Error("kcc20_policy_registry_existing_response_invalid");
  }
  policyRegistryDeployState.liveRegistry = data;
  policyRegistryDeployState.recoveryError = null;
  syncPolicyRegistryTokenFields();
  renderPolicyRegistryContext();
  setText("crRegistryCovenantId", covenantId);
  if (announce) setText("crRegistryStatus", "Existing live registry recovered. Continue to Issue or Controls.");
  renderPolicyRegistryProof({
    proof_kind: "kcc20_policy_registry_existing_live_recovery_v1",
    registry_covenant_id: covenantId,
    policy_epoch: data.policy_epoch,
    rulebook_root: data.rulebook_root,
    transaction_created: false,
    signing_required: false,
    submit_required: false
  });
  renderRegulatedIssueAssetSelection();
  renderControlContext();
  return true;
}

async function recoverCanonicalPolicyRegistry({ force = false, required = false, announce = false } = {}) {
  if (policyRegistryDeployState.recovering) return policyRegistryLiveMatchesAuthoritative();
  if (!force && policyRegistryLiveMatchesAuthoritative()) return true;
  const authoritative = policyRegistryDeployState.authoritative;
  if (!policyRegistryDeployState.walletReady || !authoritative) {
    if (required) throw new Error("kcc20_policy_registry_recovery_prerequisites_missing");
    return false;
  }

  policyRegistryDeployState.recovering = true;
  policyRegistryDeployState.recoveryError = null;
  updatePolicyRegistryButtons();
  updateRegulatedIssueControls();
  renderControlContext();
  try {
    const response = await fetch(POLICY_REGISTRY_BUILD_ROUTE, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        registry_carrier_sompi: policyRegistryKasToSompi(byId("crRegistryCarrierKas")?.value, "registry_carrier"),
        fee_reserve_sompi: policyRegistryKasToSompi(byId("crRegistryFeeReserveKas")?.value, "registry_fee_reserve")
      })
    });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok === true
      && data.application_status === "kcc20_policy_registry_existing_live_verified_tn10") {
      return acceptRecoveredPolicyRegistry(data, authoritative, { announce });
    }
    if (data?.reason === "kcc20_policy_registry_authority_wallet_required") {
      policyRegistryDeployState.liveRegistry = null;
      policyRegistryDeployState.recoveryError = data;
      syncPolicyRegistryTokenFields();
      renderPolicyRegistryContext();
      renderControlContext();
      renderRegulatedIssueAssetSelection();
      if (required) throw new Error("kcc20_policy_registry_authority_wallet_required");
      return false;
    }
    if (response.ok && data?.ok === true) {
      policyRegistryDeployState.build = null;
      policyRegistryDeployState.signedSafeJson = "";
      if (announce) setText("crRegistryStatus", `Demo Policy epoch ${authoritative.policy_epoch} requires Registry publication.`);
      if (required) throw new Error("kcc20_policy_registry_current_publication_required");
      return false;
    }
    const reason = String(data?.reason || `HTTP ${response.status}`);
    policyRegistryDeployState.recoveryError = { reason };
    if (required) throw new Error(reason);
    return false;
  } finally {
    policyRegistryDeployState.recovering = false;
    updatePolicyRegistryButtons();
    updateRegulatedIssueControls();
    renderControlContext();
  }
}

function policyRegistrySigningPlan(build) {
  const update = build?.build_kind === "kcc20_policy_registry_update_build_v1";
  const genesis = build?.build_kind === "kcc20_policy_registry_deploy_build_v1";
  if (!update && !genesis) throw new Error("kcc20_policy_registry_signing_plan_build_kind_invalid");

  const context = build?.signing_context_public;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("kcc20_policy_registry_signing_context_missing");
  }
  const nativeFundingInputIndexes = Array.isArray(context.native_kas_funding_input_indexes)
    ? context.native_kas_funding_input_indexes.map(Number)
    : [];
  const nativeFundingInputs = Array.isArray(build.native_kas_funding_inputs)
    ? build.native_kas_funding_inputs
    : [];
  const signInputIndexes = Array.isArray(build.signInputIndexes)
    ? build.signInputIndexes.map(Number)
    : [];
  const registryInputIndex = update ? Number(context.registry_input_index) : null;

  if (!nativeFundingInputIndexes.length
    || nativeFundingInputIndexes.some((index) => !Number.isInteger(index) || index < 0)
    || new Set(nativeFundingInputIndexes).size !== nativeFundingInputIndexes.length) {
    throw new Error("kcc20_policy_registry_native_funding_indexes_invalid");
  }
  const nativeInputStartIndex = update ? 1 : 0;
  const expectedNativeIndexes = nativeFundingInputIndexes.map((_, position) => nativeInputStartIndex + position);
  if (nativeFundingInputIndexes.some((index, position) => index !== expectedNativeIndexes[position])) {
    throw new Error("kcc20_policy_registry_native_funding_indexes_not_ordered");
  }
  if (update && registryInputIndex !== 0) {
    throw new Error("kcc20_policy_registry_update_registry_input_invalid");
  }
  const expectedSignInputIndexes = update
    ? [registryInputIndex, ...nativeFundingInputIndexes]
    : nativeFundingInputIndexes;
  if (signInputIndexes.length !== expectedSignInputIndexes.length
    || signInputIndexes.some((index, position) => index !== expectedSignInputIndexes[position])) {
    throw new Error("kcc20_policy_registry_sign_indexes_invalid");
  }
  if (nativeFundingInputs.length !== nativeFundingInputIndexes.length) {
    throw new Error("kcc20_policy_registry_native_funding_plan_invalid");
  }
  for (let position = 0; position < nativeFundingInputIndexes.length; position += 1) {
    const fundingInput = nativeFundingInputs[position];
    if (Number(fundingInput?.input_index) !== nativeFundingInputIndexes[position]
      || !String(fundingInput?.outpoint || "").trim()
      || !/^\d+$/.test(String(fundingInput?.amount_sompi || ""))) {
      throw new Error("kcc20_policy_registry_native_funding_plan_mismatch");
    }
  }

  return {
    update,
    genesis,
    registryInputIndex,
    nativeFundingInputIndexes,
    nativeFundingInputs,
    signInputIndexes,
    expectedInputCount: nativeInputStartIndex + nativeFundingInputIndexes.length
  };
}

async function buildPolicyRegistry() {
  try {
    policyRegistryDeployState.build = null;
    policyRegistryDeployState.signedSafeJson = "";
    const authoritative = policyRegistryDeployState.authoritative;
    if (!authoritative) throw new Error("saved_demo_policy_required_before_registry_build");
    setText("crRegistryStatus", `Preparing Registry for saved Demo Policy epoch ${authoritative.policy_epoch}…`);
    await activeIssueKeyringOrThrow(policyRegistryDeployState.activeStatus);
    const response = await fetch(POLICY_REGISTRY_BUILD_ROUTE, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        registry_carrier_sompi: policyRegistryKasToSompi(byId("crRegistryCarrierKas")?.value, "registry_carrier"),
        fee_reserve_sompi: policyRegistryKasToSompi(byId("crRegistryFeeReserveKas")?.value, "registry_fee_reserve")
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok !== true) throw new Error(String(data?.reason || `HTTP ${response.status}`));
    if (data.application_status === "kcc20_policy_registry_existing_live_verified_tn10") {
      acceptRecoveredPolicyRegistry(data, authoritative, { announce: true });
      return "recovered";
    }

    const update = data.build_kind === "kcc20_policy_registry_update_build_v1";
    const genesis = data.build_kind === "kcc20_policy_registry_deploy_build_v1";
    const expectedStatus = update
      ? "kcc20_policy_registry_update_build_ready_for_local_sign_submit_tn10"
      : "kcc20_policy_registry_deploy_build_ready_for_local_sign_submit_tn10";
    if ((!update && !genesis) || data.application_status !== expectedStatus
      || data.submit_route !== POLICY_REGISTRY_SUBMIT_ROUTE
      || !/^[0-9a-f]{64}$/.test(String(data.registry_covenant_id || ""))
      || data.policy_source_mode !== "Testnet-10 Local Demo Policy" || data.local_demo_policy !== true
      || String(data.rulebook_root || "") !== authoritative.rulebook_root
      || String(data.source_policy_snapshot_id || "") !== authoritative.source_policy_snapshot_id
      || Number(data.policy_epoch) !== authoritative.policy_epoch
      || data.submit_intent_required !== (update ? "submit_kcc20_policy_registry_update_v1" : "submit_kcc20_policy_registry_deploy_v1")) {
      throw new Error("kcc20_policy_registry_build_response_invalid");
    }
    const signingPlan = policyRegistrySigningPlan(data);
    if (signingPlan.update !== update || signingPlan.genesis !== genesis) {
      throw new Error("kcc20_policy_registry_build_signing_plan_mismatch");
    }
    if (update && (data.covenant_id_continuity !== true || data.previous_root_linked !== true)) {
      throw new Error("kcc20_policy_registry_update_continuity_invalid");
    }
    policyRegistryDeployState.build = data;
    renderPolicyRegistryProof({
      proof_kind: update ? "kcc20_policy_registry_tn10_update_build_v1" : "kcc20_policy_registry_tn10_build_v1",
      registry_operation: update ? "update" : "genesis",
      registry_covenant_id: data.registry_covenant_id,
      previous_policy_epoch: data.previous_policy_epoch ?? null,
      policy_epoch: data.policy_epoch,
      previous_rulebook_root: data.previous_rulebook_root ?? null,
      rulebook_root: data.rulebook_root,
      covenant_id_continuity: update ? data.covenant_id_continuity === true : null,
      native_kas_funding_input_count: signingPlan.nativeFundingInputIndexes.length,
      signing_enabled: true,
      broadcasting_enabled: false
    });
    setText("crRegistryStatus", update ? "Registry update prepared. Signing locally…" : "Registry transaction prepared. Signing locally…");
    return "built";
  } catch (errorValue) {
    renderPolicyRegistryProof({ ok: false, reason: errorValue instanceof Error ? errorValue.message : "kcc20_policy_registry_build_failed" });
    setText("crRegistryStatus", "Registry build failed.");
    return null;
  } finally {
    updatePolicyRegistryButtons();
  }
}

async function signPolicyRegistry() {
  try {
    const build = policyRegistryDeployState.build;
    if (!build) throw new Error("kcc20_policy_registry_build_required");
    const keyring = await activeIssueKeyringOrThrow(policyRegistryDeployState.activeStatus);
    if (window.kaspaReady && typeof window.kaspaReady.then === "function") await window.kaspaReady;
    const k = window.kaspa;
    const tx = k.Transaction.deserializeFromSafeJSON(String(build.txToSignSafeJson || ""));
    const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
    const signingPlan = policyRegistrySigningPlan(build);
    const { update, registryInputIndex, nativeFundingInputIndexes, expectedInputCount } = signingPlan;
    if (inputs.length !== expectedInputCount
      || nativeFundingInputIndexes.some((index) => !inputs[index])) {
      throw new Error("kcc20_policy_registry_signing_inputs_invalid");
    }

    if (update) {
      const context = build.signing_context_public;
      const redeemHex = String(context?.source_registry_redeem_script_hex || "").trim();
      if (!inputs[registryInputIndex]
        || !/^[0-9a-f]+$/i.test(redeemHex) || redeemHex.length % 2 !== 0) {
        throw new Error("kcc20_policy_registry_update_signing_context_invalid");
      }
      const script = k.ScriptBuilder.fromScript(redeemHex);
      const signature = k.createInputSignature(tx, registryInputIndex, keyring.privateKey, null);
      inputs[registryInputIndex].signatureScript = script.encodePayToScriptHashSignatureScript(signature);
    }
    for (const fundingInputIndex of nativeFundingInputIndexes) {
      inputs[fundingInputIndex].signatureScript = k.createInputSignature(tx, fundingInputIndex, keyring.privateKey, null);
    }

    tx.inputs = inputs;
    tx.finalize();
    policyRegistryDeployState.signedSafeJson = tx.serializeToSafeJSON();
    k.Transaction.deserializeFromSafeJSON(policyRegistryDeployState.signedSafeJson);
    renderPolicyRegistryProof({
      proof_kind: update ? "kcc20_policy_registry_tn10_update_sign_only_v1" : "kcc20_policy_registry_tn10_sign_only_v1",
      registry_covenant_id: build.registry_covenant_id,
      native_kas_funding_signature_count: nativeFundingInputIndexes.length,
      registry_authority_signature_present: update,
      signed_tx_deserialize_check_ok: true,
      private_key_printed: false,
      signature_script_printed: false,
      signed_transaction_printed: false
    });
    setText("crRegistryStatus", update ? "Registry update signed locally. Submitting…" : "Registry signed locally. Submitting…");
    return true;
  } catch (errorValue) {
    policyRegistryDeployState.signedSafeJson = "";
    renderPolicyRegistryProof({ ok: false, reason: errorValue instanceof Error ? errorValue.message : "kcc20_policy_registry_sign_failed" });
    setText("crRegistryStatus", "Registry signing failed.");
    return false;
  } finally {
    updatePolicyRegistryButtons();
  }
}

async function submitPolicyRegistry() {
  try {
    const build = policyRegistryDeployState.build;
    if (!build || !policyRegistryDeployState.signedSafeJson) throw new Error("kcc20_policy_registry_signed_build_required");
    policyRegistryDeployState.submitting = true;
    updatePolicyRegistryButtons();
    const response = await fetch(POLICY_REGISTRY_SUBMIT_ROUTE, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        submit_intent: build.submit_intent_required,
        submit_token: build.submit_token,
        signedSafeJson: policyRegistryDeployState.signedSafeJson
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok !== true) throw new Error(String(data?.reason || `HTTP ${response.status}`));
    const covenantId = String(data.registry_covenant_id || "").trim().toLowerCase();
    const authoritative = policyRegistryDeployState.authoritative;
    if (!/^[0-9a-f]{64}$/.test(covenantId) || !authoritative
      || data.policy_source_mode !== "Testnet-10 Local Demo Policy" || data.local_demo_policy !== true
      || String(data.rulebook_root || "") !== authoritative.rulebook_root
      || String(data.source_policy_snapshot_id || "") !== authoritative.source_policy_snapshot_id
      || Number(data.policy_epoch) !== authoritative.policy_epoch
      || !new Set(["genesis", "update"]).has(String(data.registry_operation || ""))) {
      throw new Error("kcc20_policy_registry_submit_response_invalid");
    }
    policyRegistryDeployState.liveRegistry = data;
    syncPolicyRegistryTokenFields();
    renderPolicyRegistryContext();
    setText("crRegistryCovenantId", covenantId);
    const live = ["kcc20_policy_registry_submitted_live_verified_tn10", "kcc20_policy_registry_updated_live_verified_tn10"].includes(data.application_status);
    setText("crRegistryStatus", live ? `Registry is live for Demo Policy epoch ${data.policy_epoch}. Continue to Issue.`
      : "Registry submitted; visibility is pending. Refresh before Issue.");
    renderPolicyRegistryProof({
      proof_kind: data.registry_operation === "update" ? "kcc20_policy_registry_tn10_update_submit_v1" : "kcc20_policy_registry_tn10_submit_v1",
      application_status: data.application_status,
      registry_operation: data.registry_operation,
      registry_covenant_id: covenantId,
      previous_policy_epoch: data.previous_policy_epoch ?? null,
      policy_epoch: data.policy_epoch,
      rulebook_root: data.rulebook_root,
      submitted_txid: data.submitted_txid,
      covenant_id_continuity: data.covenant_id_continuity ?? null,
      local_registry_record_written: data.local_registry_record_written === true,
      signed_transaction_json_echoed: false,
      signature_script_echoed: false
    });
    policyRegistryDeployState.build = null;
    policyRegistryDeployState.signedSafeJson = "";
    renderRegulatedIssueAssetSelection();
    updateRegulatedIssueControls();
    renderControlContext();
    return true;
  } catch (errorValue) {
    renderPolicyRegistryProof({ ok: false, reason: errorValue instanceof Error ? errorValue.message : "kcc20_policy_registry_submit_failed" });
    setText("crRegistryStatus", "Registry submission failed.");
    return false;
  } finally {
    policyRegistryDeployState.submitting = false;
    updatePolicyRegistryButtons();
  }
}


async function deployPolicyRegistryOneClick() {
  if (policyRegistryDeployState.orchestrating || policyRegistryDeployState.submitting) return;
  if (policyRegistryLiveMatchesAuthoritative()) {
    renderPolicyRegistryContext();
    updatePolicyRegistryButtons();
    return;
  }

  policyRegistryDeployState.orchestrating = true;
  updatePolicyRegistryButtons();
  try {
    if (!policyRegistryDeployState.build) {
      const buildResult = await buildPolicyRegistry();
      if (buildResult === "recovered") return;
      if (buildResult !== "built") return;
    }

    if (!policyRegistryDeployState.signedSafeJson) {
      const signed = await signPolicyRegistry();
      if (!signed) return;
    }

    await submitPolicyRegistry();
  } finally {
    policyRegistryDeployState.orchestrating = false;
    updatePolicyRegistryButtons();
  }
}

async function enrollDeployedRegulatedAssetAndPublish(assetCovenantId, submittedTxid) {
  const assetId = String(assetCovenantId || "").trim().toLowerCase();
  const txid = String(submittedTxid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(assetId) || !/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error("kcc20_regulated_deploy_auto_enrollment_identity_invalid");
  }
  if (regulatedDeployEnrollmentState.busy) return false;
  if (regulatedDeployEnrollmentState.assetCovenantId === assetId
    && demoPolicyState.policy?.regulated_asset_covenant_ids?.includes(assetId)
    && policyRegistryLiveMatchesAuthoritative()) {
    await refreshRegulatedIssueAssets(assetId);
    return true;
  }

  regulatedDeployEnrollmentState.busy = true;
  regulatedDeployEnrollmentState.assetCovenantId = assetId;
  demoPolicyState.busy = true;
  updateDemoPolicyButtons();
  updatePolicyRegistryButtons();
  setText("crDeploySuccessMessage", "Token is live. Enrolling its covenant ID into the Demo Policy and publishing the same Registry…");

  try {
    if (!demoPolicyState.policy) {
      await loadDemoPolicy({ announce: false });
    }
    if (!demoPolicyState.policy) {
      throw new Error("kcc20_regulated_deploy_auto_enrollment_saved_policy_required");
    }

    const recovered = await recoverCanonicalPolicyRegistry({ force: true, required: true, announce: false });
    if (!recovered || !policyRegistryLiveMatchesAuthoritative()) {
      throw new Error("kcc20_regulated_deploy_auto_enrollment_current_registry_required");
    }
    const authority = policyRegistryAuthorityState();
    if (!authority.activeWalletIsAuthority) {
      throw new Error("kcc20_regulated_deploy_registry_authority_wallet_required");
    }
    const registryIdBefore = String(policyRegistryDeployState.liveRegistry?.registry_covenant_id || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(registryIdBefore)) {
      throw new Error("kcc20_regulated_deploy_auto_enrollment_registry_id_invalid");
    }

    const previousEpoch = Number(demoPolicyState.policy.policy_epoch || 0);
    const policy = demoPolicyContent(demoPolicyState.policy);
    const assets = new Set(policy.regulated_asset_covenant_ids);
    if (!assets.has(assetId)) {
      assets.add(assetId);
      policy.regulated_asset_covenant_ids = [...assets].sort((a, b) => a.localeCompare(b));
      demoPolicySetStatus("loading", "Enrolling token…", `Saving ${assetId} as the next Demo Policy epoch…`);
      const { response, data } = await demoPolicyJsonRequest(DEMO_POLICY_UPDATE_ROUTE, {
        method: "POST",
        body: JSON.stringify({ policy })
      });
      if (!response.ok) {
        throw new Error(typeof data?.reason === "string" ? data.reason : `HTTP ${response.status}`);
      }
      const saved = demoPolicyResponseOrThrow(data);
      if (saved.noOp || saved.writesToDisk !== true || saved.policy.policy_epoch !== previousEpoch + 1) {
        throw new Error("kcc20_regulated_deploy_auto_enrollment_policy_epoch_invalid");
      }
      if (stableJson(demoPolicyContent(saved.policy)) !== stableJson(policy)) {
        throw new Error("kcc20_regulated_deploy_auto_enrollment_saved_policy_mismatch");
      }
      demoPolicyRenderResponse(
        data,
        `Token ${assetId} enrolled at Demo Policy epoch ${saved.policy.policy_epoch}. Publishing the same Registry…`
      );
    }

    await deployPolicyRegistryOneClick();
    if (!policyRegistryLiveMatchesAuthoritative()) {
      throw new Error("kcc20_regulated_deploy_auto_enrollment_registry_publication_failed");
    }
    const registryIdAfter = String(policyRegistryDeployState.liveRegistry?.registry_covenant_id || "").trim().toLowerCase();
    if (registryIdAfter !== registryIdBefore) {
      throw new Error("kcc20_regulated_deploy_auto_enrollment_registry_identity_changed");
    }
    if (!demoPolicyState.policy?.regulated_asset_covenant_ids?.includes(assetId)) {
      throw new Error("kcc20_regulated_deploy_auto_enrollment_asset_not_governed");
    }

    setText(
      "crDeploySuccessMessage",
      `The zero-supply token is live, governed by Registry ${registryIdAfter}, and ready for Issue at Demo Policy epoch ${demoPolicyState.policy.policy_epoch}.`
    );
    setText("crRegistryStatus", `Registry is live and governs the new token at Demo Policy epoch ${demoPolicyState.policy.policy_epoch}.`);
    await refreshRegulatedIssueAssets(assetId);
    return true;
  } catch (errorValue) {
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_deploy_auto_enrollment_failed";
    demoPolicySetStatus(
      "pending",
      "Publication pending",
      `The token is live at zero supply, but automatic policy enrollment/publication needs attention: ${reason}`
    );
    setText(
      "crDeploySuccessMessage",
      `The zero-supply token is live. Governance publication is pending and may be resumed without redeploying the token: ${reason}`
    );
    setText("crRegistryStatus", `Governance publication pending: ${reason}`);
    return false;
  } finally {
    regulatedDeployEnrollmentState.busy = false;
    demoPolicyState.busy = false;
    updateDemoPolicyButtons();
    updatePolicyRegistryButtons();
    renderControlContext();
  }
}

async function fetchRegulatedIssueAssets(status) {
  const holdingsResponse = await fetch("/api/wallet/holdings?strict=1", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  const holdings = await holdingsResponse.json().catch(() => null);
  if (!holdingsResponse.ok || !holdings || typeof holdings !== "object" || Array.isArray(holdings)) {
    const reason = typeof holdings?.reason === "string" && holdings.reason.trim()
      ? holdings.reason.trim()
      : `HTTP ${holdingsResponse.status}`;
    throw new Error(reason);
  }
  return regulatedIssuerAssetsFromHoldings(holdings, String(status.address0 || "").trim());
}

async function refreshRegulatedIssueAssets(preferredAssetId = "") {
  if (!issueDepositState.walletReady || !issueDepositState.activeStatus) {
    await initializeIssueWorkspace();
    return;
  }
  issueDepositState.refreshingAssets = true;
  updateRegulatedIssueControls();
  setText("crIssueAuthorizationStatus", "Refreshing issuer-controlled KCC20-Regulated controllers…");
  try {
    issueDepositState.regulatedAssets = await fetchRegulatedIssueAssets(issueDepositState.activeStatus);
    populateRegulatedIssueAssets(preferredAssetId);
    if (!String(byId("crIssueRecipientAddress")?.value || "").trim()) {
      const recipient = byId("crIssueRecipientAddress");
      if (recipient) recipient.value = String(issueDepositState.activeStatus.address0 || "");
    }
    const asset = selectedRegulatedIssueAsset();
    const policyStatus = regulatedIssuePolicyStatus(asset);
    setText("crIssueAuthorizationStatus", issueDepositState.regulatedAssets.length
      ? policyStatus.message
      : "No issuer-controlled KCC20-Regulated controller is currently available.");
    await loadSelectedTokenMetadata({ announce: false });
  } catch (errorValue) {
    issueDepositState.regulatedAssets = [];
    populateRegulatedIssueAssets();
    clearTokenMetadata("Token metadata is unavailable because the regulated controller list could not be refreshed.");
    const reason = errorValue instanceof Error ? errorValue.message : "regulated_issue_holdings_refresh_failed";
    setText("crIssueAuthorizationStatus", `Regulated controller refresh failed: ${reason}`);
  } finally {
    issueDepositState.refreshingAssets = false;
    updateRegulatedIssueControls();
  }
}

async function initializeIssueWorkspace() {
  let registryWalletReady = false;
  let demoPolicyWalletReady = false;
  issueDepositState.walletReady = false;
  issueDepositState.activeStatus = null;
  issueDepositState.regulatedAssets = [];
  demoPolicyState.walletReady = false;
  demoPolicyState.activeStatus = null;
  demoPolicyRenderUnavailable("Checking active wallet eligibility for the Testnet-10 Demo Policy…");
  clearIssueDepositVerification("Checking active wallet eligibility…");
  clearTokenMetadata("Checking active wallet eligibility for Token Metadata…");
  populateRegulatedIssueAssets();

  try {
    const statusResponse = await fetch("/api/wallet/status", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    const status = await statusResponse.json().catch(() => null);
    if (!statusResponse.ok || status?.ok !== true) {
      const reason = typeof status?.reason === "string" && status.reason.trim()
        ? status.reason.trim()
        : `HTTP ${statusResponse.status}`;
      throw new Error(reason);
    }
    const networkMeta = window.CwNetworkShared?.getNetworkMeta(status.network || "");
    const walletReady = String(status.state || "").trim().toUpperCase() === "READY";
    const testnet10 = networkMeta?.sdkNetworkId === "testnet-10";
    if (!walletReady || !testnet10) throw new Error(!walletReady ? "active_wallet_not_ready" : "kcc20_regulated_issue_testnet_10_only");

    policyRegistryDeployState.activeStatus = status;
    policyRegistryDeployState.walletReady = true;
    registryWalletReady = true;
    demoPolicyState.activeStatus = status;
    demoPolicyState.walletReady = true;
    demoPolicyWalletReady = true;
    issueDepositState.activeStatus = status;
    issueDepositState.walletReady = true;

    const recipient = byId("crIssueRecipientAddress");
    if (recipient && !String(recipient.value || "").trim()) recipient.value = String(status.address0 || "");

    await loadDemoPolicy({ announce: false }).catch(() => undefined);
    await recoverCanonicalPolicyRegistry({ announce: false }).catch(() => false);
    renderPolicyRegistryContext();
    updatePolicyRegistryButtons();
    issueDepositState.regulatedAssets = await fetchRegulatedIssueAssets(status);
    populateRegulatedIssueAssets();
    const asset = selectedRegulatedIssueAsset();
    setText("crIssueAuthorizationStatus", issueDepositState.regulatedAssets.length
      ? regulatedIssuePolicyStatus(asset).message
      : "READY Testnet-10 wallet detected, but no issuer-controlled KCC20-Regulated controller is available.");
    await loadSelectedTokenMetadata({ announce: false });
    updateRegulatedIssueControls();
  } catch (errorValue) {
    issueDepositState.walletReady = false;
    issueDepositState.activeStatus = null;
    issueDepositState.regulatedAssets = [];
    if (!registryWalletReady) {
      policyRegistryDeployState.activeStatus = null;
      policyRegistryDeployState.walletReady = false;
      renderPolicyRegistryContext();
      updatePolicyRegistryButtons();
    }
    if (!demoPolicyWalletReady) {
      demoPolicyState.activeStatus = null;
      demoPolicyState.walletReady = false;
      demoPolicyRenderUnavailable("Demo Policy unavailable: a READY Testnet-10 wallet is required.");
    }
    populateRegulatedIssueAssets();
    const reason = errorValue instanceof Error ? errorValue.message : "active_wallet_status_unavailable";
    clearTokenMetadata(`Token Metadata unavailable: ${reason}`);
    clearIssueDepositVerification(`Regulated Issue unavailable: ${reason}`);
  }
}


const REGULATED_AUDIT_ACTION_KINDS = new Set([
  "policy_create", "policy_update", "policy_reset",
  "registry_deploy", "registry_recover", "registry_update",
  "regulated_deploy", "regulated_asset_enrollment", "regulated_issue",
  "holder_transfer", "holder_burn", "change_owner",
  "freeze_holder", "unfreeze_holder", "freeze_outpoint", "unfreeze_outpoint",
  "seize", "forced_burn", "controller_supply_update", "regression_check"
]);

const REGULATED_AUDIT_STAGES = new Set([
  "planned", "built", "signed_locally", "submitted", "accepted",
  "live_verified", "tracking_updated", "supply_update_pending", "rejected"
]);

const REGULATED_AUDIT_OUTCOMES = new Set(["success", "pending", "rejected", "informational"]);
const REGULATED_AUDIT_ORIGINS = new Set(["audit_journal", "canonical_projection"]);
const REGULATED_AUDIT_FORBIDDEN_KEYS = new Set([
  "submit_token", "signed_transaction_json", "signature_script", "redeem_script",
  "private_key", "seed", "passphrase", "admin_token", "api_key",
  "signer_material", "custody_material"
]);

const REGULATED_AUDIT_ACTION_LABELS = Object.freeze({
  policy_create: "Policy Created",
  policy_update: "Policy Updated",
  policy_reset: "Policy Reset",
  registry_deploy: "Registry Deployed",
  registry_recover: "Registry Recovered",
  registry_update: "Registry Updated",
  regulated_deploy: "Regulated Token Deployed",
  regulated_asset_enrollment: "Asset Enrolled",
  regulated_issue: "Regulated Tokens Issued",
  holder_transfer: "Holder Transfer",
  holder_burn: "Holder Burn",
  change_owner: "Ownership Changed",
  freeze_holder: "Holder Frozen",
  unfreeze_holder: "Holder Unfrozen",
  freeze_outpoint: "Outpoint Frozen",
  unfreeze_outpoint: "Outpoint Unfrozen",
  seize: "Seizure",
  forced_burn: "Forced Burn",
  controller_supply_update: "Controller Supply Updated",
  regression_check: "Regression Check"
});

const REGULATED_AUDIT_STAGE_LABELS = Object.freeze({
  planned: "Planned",
  built: "Built",
  signed_locally: "Signed locally",
  submitted: "Submitted",
  accepted: "Accepted",
  live_verified: "Live verified",
  tracking_updated: "Tracking updated",
  supply_update_pending: "Supply update pending",
  rejected: "Rejected"
});

function regulatedAuditSetBadge(id, state, label) {
  const badge = byId(id);
  if (!badge) return;
  badge.dataset.state = state;
  badge.textContent = label;
}

function regulatedAuditSetControls(enabled) {
  [
    "crAuditAssetFilter", "crAuditActionFilter", "crAuditStageFilter",
    "crAuditOutcomeFilter", "crAuditFromDate", "crAuditToDate",
    "crAuditSearch", "crAuditRefreshBtn", "crAuditExportBtn",
    "crAuditClearFiltersBtn"
  ].forEach((id) => {
    const element = byId(id);
    if (element) element.disabled = !enabled;
  });
  const refresh = byId("crAuditRefreshBtn");
  if (refresh) refresh.textContent = regulatedAuditState.loading ? "Refreshing Audit…" : "Refresh Audit";
  const exportButton = byId("crAuditExportBtn");
  if (exportButton) exportButton.textContent = regulatedAuditState.exporting ? "Exporting…" : "Export Testnet Report";
  if (refresh) refresh.disabled = !enabled || regulatedAuditState.loading || regulatedAuditState.exporting || regulatedAuditState.completingSupply;
  if (exportButton) exportButton.disabled = !enabled || regulatedAuditState.loading || regulatedAuditState.exporting || regulatedAuditState.completingSupply;
  const completeSupply = byId("crAuditCompleteSupplyBtn");
  if (completeSupply) {
    completeSupply.disabled = !enabled
      || !regulatedAuditState.pendingSupplyAction
      || regulatedAuditState.loading
      || regulatedAuditState.exporting
      || regulatedAuditState.completingSupply;
    completeSupply.textContent = regulatedAuditState.completingSupply
      ? "Completing Supply Update…"
      : "Complete Pending Supply Update";
  }
}

function regulatedAuditAssertSanitized(value, pathText = "audit") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => regulatedAuditAssertSanitized(item, `${pathText}[${index}]`));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (REGULATED_AUDIT_FORBIDDEN_KEYS.has(String(key).trim().toLowerCase())) {
      throw new Error(`kcc20_regulated_audit_forbidden_key:${pathText}.${key}`);
    }
    regulatedAuditAssertSanitized(nested, `${pathText}.${key}`);
  }
}

function regulatedAuditEventOrThrow(event, index) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error(`kcc20_regulated_audit_event_${index}_invalid`);
  }
  if (event.schema_kind !== "kcc20_regulated_audit_event_v1" || event.schema_version !== 1) {
    throw new Error(`kcc20_regulated_audit_event_${index}_schema_invalid`);
  }
  if (!REGULATED_AUDIT_ACTION_KINDS.has(event.action_kind)) {
    throw new Error(`kcc20_regulated_audit_event_${index}_action_invalid`);
  }
  if (!REGULATED_AUDIT_STAGES.has(event.stage)) {
    throw new Error(`kcc20_regulated_audit_event_${index}_stage_invalid`);
  }
  if (!REGULATED_AUDIT_OUTCOMES.has(event.outcome)) {
    throw new Error(`kcc20_regulated_audit_event_${index}_outcome_invalid`);
  }
  if (!REGULATED_AUDIT_ORIGINS.has(event.origin)) {
    throw new Error(`kcc20_regulated_audit_event_${index}_origin_invalid`);
  }
  if (!String(event.event_id || "").trim() || !String(event.correlation_id || "").trim()) {
    throw new Error(`kcc20_regulated_audit_event_${index}_identity_invalid`);
  }
  if (Number.isNaN(Date.parse(String(event.occurred_at || "")))) {
    throw new Error(`kcc20_regulated_audit_event_${index}_occurred_at_invalid`);
  }
  if (!event.safety || typeof event.safety !== "object" || Array.isArray(event.safety)) {
    throw new Error(`kcc20_regulated_audit_event_${index}_safety_invalid`);
  }
  regulatedAuditAssertSanitized(event, `events[${index}]`);
  return event;
}

function regulatedAuditResponseOrThrow(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.ok !== true) {
    throw new Error("kcc20_regulated_audit_response_invalid");
  }
  if (data.proof_kind !== "kcc20_regulated_audit_projection_v1"
    || data.audit_kind !== REGULATED_AUDIT_REPORT_KIND) {
    throw new Error("kcc20_regulated_audit_response_kind_invalid");
  }
  if (data.demo_only !== true || data.production_eligible !== false || data.legal_validity_claimed !== false) {
    throw new Error("kcc20_regulated_audit_scope_invalid");
  }
  if (data.signing_enabled !== false || data.broadcasting_enabled !== false || data.minting_enabled !== false
    || data.writes_to_disk !== false || data.policy_mutation !== false) {
    throw new Error("kcc20_regulated_audit_read_only_lock_invalid");
  }
  if (!data.coverage || typeof data.coverage !== "object"
    || !data.integrity || typeof data.integrity !== "object" || data.integrity.ok !== true
    || !data.current_context || typeof data.current_context !== "object"
    || !data.summary || typeof data.summary !== "object"
    || !data.available_filters || typeof data.available_filters !== "object"
    || !Array.isArray(data.events) || !Array.isArray(data.source_manifest)) {
    throw new Error("kcc20_regulated_audit_response_shape_invalid");
  }
  data.events.forEach(regulatedAuditEventOrThrow);
  regulatedAuditAssertSanitized(data, "audit_response");
  return data;
}

function regulatedAuditShort(value, left = 10, right = 8) {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  if (text.length <= left + right + 1) return text;
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

function regulatedAuditFormatDate(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return String(value || "—");
  return date.toLocaleString();
}

function regulatedAuditActionLabel(value) {
  return REGULATED_AUDIT_ACTION_LABELS[value] || String(value || "Audit Event").replaceAll("_", " ");
}

function regulatedAuditStageLabel(value) {
  return REGULATED_AUDIT_STAGE_LABELS[value] || String(value || "").replaceAll("_", " ");
}

function regulatedAuditAssetLabel(event) {
  const symbol = String(event?.asset?.token_symbol || "").trim();
  const name = String(event?.asset?.token_name || "").trim();
  const assetId = String(event?.asset?.asset_covenant_id || "").trim();
  if (symbol && assetId) return `${symbol} · ${regulatedAuditShort(assetId)}`;
  if (name && assetId) return `${name} · ${regulatedAuditShort(assetId)}`;
  return symbol || name || (assetId ? regulatedAuditShort(assetId) : "Policy / Registry");
}

function regulatedAuditAmountLabel(event) {
  const amountEntries = Object.entries(event?.amounts || {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  const supplyEntries = Object.entries(event?.supply || {}).filter(([key, value]) => key.endsWith("_amount_raw") && value !== null && value !== undefined && value !== "");
  const selected = amountEntries[0] || supplyEntries[0] || null;
  if (!selected) return "";
  const [key, value] = selected;
  return `${String(value)} RAW (${key.replaceAll("_", " ")})`;
}

function regulatedAuditTransactionLabel(event) {
  const transaction = event?.transaction || {};
  const value = transaction.transaction_id
    || transaction.signed_transaction_id
    || transaction.preview_transaction_id
    || transaction.burn_receipt_transaction_id
    || transaction.registry_outpoint
    || null;
  return value ? regulatedAuditShort(value, 12, 10) : "";
}

function regulatedAuditCreateMeta(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function regulatedAuditRenderTimeline(events) {
  const timeline = byId("crAuditTimeline");
  const empty = byId("crAuditEmpty");
  if (!timeline || !empty) return;
  timeline.querySelectorAll(".cr-audit-event").forEach((node) => node.remove());
  empty.hidden = events.length !== 0;
  empty.textContent = events.length ? "" : "No Audit events match the current filters.";

  for (const event of events) {
    const article = document.createElement("article");
    article.className = "cr-audit-event";
    article.dataset.outcome = event.outcome;

    const head = document.createElement("div");
    head.className = "cr-audit-event-head";
    const heading = document.createElement("h5");
    heading.className = "cr-audit-event-title";
    heading.textContent = `${regulatedAuditActionLabel(event.action_kind)} · ${regulatedAuditStageLabel(event.stage)}`;
    const badge = document.createElement("span");
    badge.className = "cr-status-badge";
    badge.dataset.state = event.outcome === "success" ? "verified" : (event.outcome === "rejected" ? "failed" : "pending");
    badge.textContent = event.outcome;
    head.append(heading, badge);

    const meta = document.createElement("div");
    meta.className = "cr-audit-event-meta";
    const metaValues = [
      regulatedAuditFormatDate(event.occurred_at),
      regulatedAuditAssetLabel(event),
      regulatedAuditAmountLabel(event),
      regulatedAuditTransactionLabel(event),
      event.origin === "audit_journal" ? "Journaled" : "Historical projection"
    ].filter(Boolean);
    metaValues.forEach((value) => meta.appendChild(regulatedAuditCreateMeta(value)));

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Evidence";
    const pre = document.createElement("pre");
    pre.className = "logbox mono cr-audit-evidence";
    pre.textContent = JSON.stringify(event, null, 2);
    details.append(summary, pre);
    article.append(head, meta, details);
    timeline.appendChild(article);
  }

  regulatedAuditSetBadge(
    "crAuditVisibleCount",
    events.length ? "verified" : "loading",
    `${events.length} event${events.length === 1 ? "" : "s"}`
  );
}

function regulatedAuditPopulateSelect(id, values, labeler) {
  const select = byId(id);
  if (!select) return;
  const previous = String(select.value || "");
  const first = select.options[0]?.cloneNode(true) || new Option("All", "");
  select.innerHTML = "";
  select.appendChild(first);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = labeler(value);
    select.appendChild(option);
  }
  select.value = values.includes(previous) ? previous : "";
}

function regulatedAuditPendingSupplyActionOrThrow(pending) {
  if (!pending || typeof pending !== "object" || Array.isArray(pending)
    || pending.action_kind !== "controller_supply_update"
    || pending.stage !== "supply_update_pending"
    || pending.outcome !== "pending") {
    throw new Error("kcc20_regulated_audit_pending_supply_action_invalid");
  }
  const assetCovenantId = String(pending.asset?.asset_covenant_id || "").trim().toLowerCase();
  const tokenSymbol = String(pending.asset?.token_symbol || "").trim();
  const burnReceiptTxid = String(pending.transaction?.burn_receipt_transaction_id || pending.correlation_id || "").trim().toLowerCase();
  const burnAmountRaw = String(pending.supply?.burn_amount_raw || pending.amounts?.burn_amount_raw || "").trim();
  if (!/^[0-9a-f]{64}$/.test(assetCovenantId)
    || !/^[0-9a-f]{64}$/.test(burnReceiptTxid)
    || !/^\d+$/.test(burnAmountRaw)
    || BigInt(burnAmountRaw) <= 0n) {
    throw new Error("kcc20_regulated_audit_pending_supply_binding_invalid");
  }
  return Object.freeze({ assetCovenantId, tokenSymbol, burnReceiptTxid, burnAmountRaw });
}

function regulatedAuditRenderPending(data) {
  const pending = data.events.find((event) =>
    event.action_kind === "controller_supply_update"
    && event.stage === "supply_update_pending"
    && event.outcome === "pending"
  ) || null;
  const wrap = byId("crAuditPendingWrap");
  regulatedAuditState.pendingSupplyAction = null;
  if (wrap) wrap.hidden = !pending;
  if (!pending) {
    setText("crAuditCompleteSupplyStatus", "No pending controller-supply receipt.");
    return;
  }
  const binding = regulatedAuditPendingSupplyActionOrThrow(pending);
  regulatedAuditState.pendingSupplyAction = binding;
  const status = pending.supply?.controller_supply_update_status || "controller supply update pending";
  setText("crAuditPendingAsset", binding.tokenSymbol ? `${binding.tokenSymbol} · ${regulatedAuditShort(binding.assetCovenantId)}` : regulatedAuditShort(binding.assetCovenantId));
  setText("crAuditPendingAmount", binding.burnAmountRaw);
  setText("crAuditPendingTxid", binding.burnReceiptTxid);
  setText("crAuditPendingStatus", status);
  setText("crAuditPendingMessage", "The holder burn succeeded. Complete the existing controller-supply accounting step; do not repeat the accepted burn.");
  setText("crAuditCompleteSupplyStatus", "Ready to complete only this verified pending receipt. The holder burn will not be repeated.");
}

function regulatedAuditRenderReport(data) {
  const coverageStatus = String(data.coverage.status || "partial");
  const journalStatus = String(data.integrity.audit_journal_status || "unknown");
  const currentPolicy = data.current_context.current_policy || null;
  const registryIds = Array.isArray(data.current_context.registry_covenant_ids)
    ? data.current_context.registry_covenant_ids
    : [];
  const manifestPresent = data.source_manifest.filter((row) => row?.exists === true).length;
  const manifestRequired = data.source_manifest.filter((row) => row?.source_kind !== "audit_journal").length;
  const canonicalPresent = data.source_manifest.filter((row) => row?.source_kind !== "audit_journal" && row?.exists === true).length;

  regulatedAuditSetBadge(
    "crAuditIntegrityBadge",
    coverageStatus === "partial" ? "pending" : "verified",
    coverageStatus === "partial" ? "Verified · Partial history" : "Verified"
  );
  setText(
    "crAuditStatus",
    journalStatus === "not_initialized"
      ? "Read-only canonical evidence loaded. Earlier history is partial; the append-only journal will initialize when the next instrumented action occurs."
      : "Read-only evidence loaded. The append-only journal hash chain and surviving canonical source records passed validation."
  );
  setText("crAuditCoverage", coverageStatus === "partial" ? "Partial historical projection" : coverageStatus.replaceAll("_", " "));
  setText("crAuditChainStatus", journalStatus === "present_and_chain_verified"
    ? `${data.integrity.audit_journal_event_count || 0} events · hash chain verified`
    : "Not initialized · canonical records only");
  setText("crAuditPolicyEpoch", currentPolicy?.policy_epoch ?? "—");
  setText("crAuditRulebookRoot", currentPolicy?.rulebook_root || "—");
  setText("crAuditRegistryId", registryIds.length ? registryIds.map((value) => regulatedAuditShort(value)).join(" · ") : "—");
  setText("crAuditSourceManifestStatus", `${canonicalPresent}/${manifestRequired} canonical sources available · ${manifestPresent} total files present`);

  setText("crAuditTotalEvents", data.summary.total_events ?? 0);
  setText("crAuditLiveVerified", data.summary.live_verified ?? 0);
  setText("crAuditRejected", data.summary.rejected ?? 0);
  setText("crAuditPendingCount", data.summary.pending ?? 0);
  setText("crAuditAssetCount", data.summary.regulated_assets ?? 0);
  setText("crAuditCurrentEpoch", data.summary.current_policy_epoch ?? "—");

  const symbolByAsset = new Map();
  for (const event of data.events) {
    const assetId = String(event.asset?.asset_covenant_id || "").trim();
    const symbol = String(event.asset?.token_symbol || "").trim();
    if (assetId && symbol && !symbolByAsset.has(assetId)) symbolByAsset.set(assetId, symbol);
  }
  const filters = data.available_filters;
  regulatedAuditPopulateSelect("crAuditAssetFilter", Array.isArray(filters.assets) ? filters.assets : [], (value) => {
    const symbol = symbolByAsset.get(value);
    return symbol ? `${symbol} · ${regulatedAuditShort(value)}` : regulatedAuditShort(value);
  });
  regulatedAuditPopulateSelect("crAuditActionFilter", Array.isArray(filters.action_kinds) ? filters.action_kinds : [], regulatedAuditActionLabel);
  regulatedAuditPopulateSelect("crAuditStageFilter", Array.isArray(filters.stages) ? filters.stages : [], regulatedAuditStageLabel);
  regulatedAuditPopulateSelect("crAuditOutcomeFilter", Array.isArray(filters.outcomes) ? filters.outcomes : [], (value) => value);

  regulatedAuditRenderPending(data);
  regulatedAuditRenderTimeline(data.events);
  setText("crAuditEvidence", JSON.stringify({
    audit_kind: data.audit_kind,
    coverage: data.coverage,
    integrity: data.integrity,
    current_context: data.current_context,
    filters: data.filters,
    source_manifest: data.source_manifest,
    read_only_guards: {
      signing_enabled: data.signing_enabled,
      broadcasting_enabled: data.broadcasting_enabled,
      minting_enabled: data.minting_enabled,
      writes_to_disk: data.writes_to_disk,
      policy_mutation: data.policy_mutation
    }
  }, null, 2));
  regulatedAuditSetControls(true);
}

function regulatedAuditQueryString() {
  const params = new URLSearchParams();
  const mappings = [
    ["crAuditAssetFilter", "asset"],
    ["crAuditActionFilter", "action_kind"],
    ["crAuditStageFilter", "stage"],
    ["crAuditOutcomeFilter", "outcome"],
    ["crAuditSearch", "search"]
  ];
  for (const [id, key] of mappings) {
    const value = String(byId(id)?.value || "").trim();
    if (value) params.set(key, value);
  }
  const fromDate = String(byId("crAuditFromDate")?.value || "").trim();
  const toDate = String(byId("crAuditToDate")?.value || "").trim();
  if (fromDate) params.set("date_from", `${fromDate}T00:00:00.000Z`);
  if (toDate) params.set("date_to", `${toDate}T23:59:59.999Z`);
  params.set("limit", "1000");
  return params.toString();
}

async function completePendingRegulatedAuditSupplyUpdate() {
  if (regulatedAuditState.completingSupply || regulatedAuditState.loading || regulatedAuditState.exporting) return;
  const pending = regulatedAuditState.pendingSupplyAction;
  if (!pending) throw new Error("kcc20_regulated_audit_pending_supply_action_required");
  const confirmed = window.confirm(
    `Complete controller-supply accounting for ${pending.burnAmountRaw} raw ${pending.tokenSymbol || "regulated token"}?\n\n`
    + `Burn receipt: ${pending.burnReceiptTxid}\n`
    + `Asset: ${pending.assetCovenantId}\n\n`
    + "This completes the existing receipt only. It does not repeat the holder burn."
  );
  if (!confirmed) return;

  regulatedAuditState.completingSupply = true;
  regulatedAuditSetControls(true);
  setText("crAuditCompleteSupplyStatus", "Recovering the Registry authority and completing the exact pending receipt…");
  setText("crAuditStatus", "Completing the existing controller-supply accounting receipt. The accepted holder burn will not be repeated.");
  try {
    const recovered = await recoverCanonicalPolicyRegistry({ force: true, required: true, announce: false });
    if (!recovered || !policyRegistryLiveMatchesAuthoritative()) {
      throw new Error("kcc20_regulated_audit_current_registry_required");
    }
    if (!policyRegistryAuthorityState().activeWalletIsAuthority) {
      throw new Error("kcc20_policy_registry_authority_wallet_required");
    }
    const keyring = await activeIssueKeyringOrThrow(policyRegistryDeployState.activeStatus);
    const result = await autoSubmitForcedBurnControllerSupplyUpdate(
      pending.assetCovenantId,
      keyring,
      { burnReceiptTxid: pending.burnReceiptTxid, burnAmountRaw: pending.burnAmountRaw }
    );
    if (result.submit_ok !== true) {
      throw new Error(String(result.reason || "kcc20_regulated_audit_controller_supply_update_failed"));
    }
    setText("crAuditCompleteSupplyStatus", `Controller supply updated. Transaction: ${result.submitted_txid}`);
    const selectedAsset = selectedRegulatedIssueAsset();
    if (String(selectedAsset?.asset_covenant_id || "").trim().toLowerCase() === pending.assetCovenantId) {
      await loadSelectedTokenMetadata({ announce: false }).catch(() => undefined);
    }
    const refreshed = await loadRegulatedAudit({ announce: false });
    const stillPending = refreshed?.events?.some((event) =>
      event.action_kind === "controller_supply_update"
      && event.stage === "supply_update_pending"
      && event.outcome === "pending"
      && String(event.transaction?.burn_receipt_transaction_id || event.correlation_id || "").trim().toLowerCase() === pending.burnReceiptTxid
    );
    if (stillPending) throw new Error("kcc20_regulated_audit_supply_update_still_pending_after_submit");
    setText("crAuditStatus", `Controller-supply accounting completed and Audit verified. Transaction: ${result.submitted_txid}`);
  } catch (errorValue) {
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_audit_controller_supply_update_failed";
    setText("crAuditCompleteSupplyStatus", `Supply update failed: ${reason}. Do not repeat the holder burn.`);
    setText("crAuditStatus", `Pending controller-supply accounting was not completed: ${reason}`);
  } finally {
    regulatedAuditState.completingSupply = false;
    regulatedAuditSetControls(!!regulatedAuditState.report);
  }
}

async function loadRegulatedAudit({ announce = true } = {}) {
  if (regulatedAuditState.loading) return regulatedAuditState.report;
  const requestSerial = ++regulatedAuditState.requestSerial;
  regulatedAuditState.loading = true;
  regulatedAuditSetControls(false);
  regulatedAuditSetBadge("crAuditIntegrityBadge", "loading", "Loading…");
  regulatedAuditSetBadge("crAuditVisibleCount", "loading", "Loading…");
  if (announce) setText("crAuditStatus", "Loading and validating the read-only Audit projection…");
  try {
    const query = regulatedAuditQueryString();
    const response = await fetch(`${REGULATED_AUDIT_ROUTE}?${query}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    const responseData = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = String(responseData?.error || responseData?.reason || `HTTP ${response.status}`).trim();
      throw new Error(reason || `HTTP ${response.status}`);
    }
    const data = regulatedAuditResponseOrThrow(responseData);
    if (requestSerial !== regulatedAuditState.requestSerial) return null;
    regulatedAuditState.report = data;
    regulatedAuditRenderReport(data);
    return data;
  } catch (errorValue) {
    if (requestSerial !== regulatedAuditState.requestSerial) return null;
    regulatedAuditState.report = null;
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_audit_load_failed";
    regulatedAuditSetBadge("crAuditIntegrityBadge", "failed", "Audit unavailable");
    regulatedAuditSetBadge("crAuditVisibleCount", "failed", "0 events");
    setText("crAuditStatus", `Audit could not be loaded: ${reason}`);
    const empty = byId("crAuditEmpty");
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Audit evidence unavailable: ${reason}`;
    }
    regulatedAuditSetControls(false);
    return null;
  } finally {
    if (requestSerial === regulatedAuditState.requestSerial) {
      regulatedAuditState.loading = false;
      regulatedAuditSetControls(!!regulatedAuditState.report);
    }
  }
}

function regulatedAuditExportFilename(response) {
  const disposition = String(response.headers.get("content-disposition") || "");
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] || "kcc20-regulated-testnet-audit-report.v1.json";
}

async function exportRegulatedAudit() {
  if (regulatedAuditState.exporting || regulatedAuditState.loading) return;
  regulatedAuditState.exporting = true;
  regulatedAuditSetControls(true);
  setText("crAuditStatus", "Generating the sanitized Testnet-10 Audit report…");
  try {
    const query = regulatedAuditQueryString();
    const response = await fetch(`${REGULATED_AUDIT_EXPORT_ROUTE}?${query}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    const text = await response.text();
    let report = null;
    try { report = JSON.parse(text); } catch { report = null; }
    if (!response.ok) {
      const reason = String(report?.error || report?.reason || `HTTP ${response.status}`).trim();
      throw new Error(reason || `HTTP ${response.status}`);
    }
    regulatedAuditResponseOrThrow(report);
    if (report.report_kind !== REGULATED_AUDIT_REPORT_KIND
      || report.notice !== "TESTNET-10 DEMONSTRATION — NOT REGULATOR CERTIFICATION") {
      throw new Error("kcc20_regulated_audit_export_scope_invalid");
    }
    regulatedAuditAssertSanitized(report, "audit_export");
    const blob = new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = regulatedAuditExportFilename(response);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setText("crAuditStatus", `Exported ${report.summary?.filtered_event_count ?? report.events?.length ?? 0} sanitized Testnet-10 Audit events.`);
  } catch (errorValue) {
    const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_audit_export_failed";
    setText("crAuditStatus", `Audit export failed: ${reason}`);
  } finally {
    regulatedAuditState.exporting = false;
    regulatedAuditSetControls(!!regulatedAuditState.report);
  }
}

function clearRegulatedAuditFilters() {
  [
    "crAuditAssetFilter", "crAuditActionFilter", "crAuditStageFilter",
    "crAuditOutcomeFilter", "crAuditFromDate", "crAuditToDate", "crAuditSearch"
  ].forEach((id) => {
    const element = byId(id);
    if (element) element.value = "";
  });
  loadRegulatedAudit().catch(() => undefined);
}

document.addEventListener("DOMContentLoaded", () => {
  byId("crIssueAssetSelect")?.addEventListener("change", () => {
    invalidateIssueBuildProof();
    loadSelectedTokenMetadata().catch(() => undefined);
  });
  ["crIssueAmountRaw", "crIssueRecipientAddress", "crIssueHolderCarrierKas"].forEach((id) => {
    byId(id)?.addEventListener("input", invalidateIssueBuildProof);
  });
  byId("crTokenMetadataRefreshBtn")?.addEventListener("click", () => {
    loadSelectedTokenMetadata().catch(() => undefined);
  });
  byId("crIssueBuildBtn")?.addEventListener("click", () => {
    issueRegulatedTokensOneClick().catch((errorValue) => {
      const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_issue_failed";
      renderRegulatedIssueProof({ ok: false, reason });
      setText("crIssueAuthorizationStatus", `Regulated Issue failed: ${reason}`);
      updateRegulatedIssueControls();
    });
  });
  document.querySelector('[data-cr-tab="issue"]')?.addEventListener("click", () => {
    recoverCanonicalPolicyRegistry({ announce: false })
      .then(() => refreshRegulatedIssueAssets())
      .catch(() => undefined);
  });
  document.querySelector('[data-cr-tab="controls"]')?.addEventListener("click", () => {
    initializeIssueWorkspace()
      .then(() => renderControlContext())
      .catch(() => undefined);
  });
  document.querySelector('[data-cr-tab="audit"]')?.addEventListener("click", () => {
    loadRegulatedAudit().catch(() => undefined);
  });
  byId("crAuditRefreshBtn")?.addEventListener("click", () => {
    loadRegulatedAudit().catch(() => undefined);
  });
  byId("crAuditExportBtn")?.addEventListener("click", () => {
    exportRegulatedAudit().catch(() => undefined);
  });
  byId("crAuditClearFiltersBtn")?.addEventListener("click", clearRegulatedAuditFilters);
  byId("crAuditCompleteSupplyBtn")?.addEventListener("click", () => {
    completePendingRegulatedAuditSupplyUpdate().catch((errorValue) => {
      const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_audit_controller_supply_update_failed";
      setText("crAuditCompleteSupplyStatus", `Supply update failed: ${reason}. Do not repeat the holder burn.`);
    });
  });
  [
    "crAuditAssetFilter", "crAuditActionFilter", "crAuditStageFilter",
    "crAuditOutcomeFilter", "crAuditFromDate", "crAuditToDate"
  ].forEach((id) => {
    byId(id)?.addEventListener("change", () => {
      loadRegulatedAudit().catch(() => undefined);
    });
  });
  byId("crAuditSearch")?.addEventListener("input", () => {
    if (regulatedAuditState.searchTimer) window.clearTimeout(regulatedAuditState.searchTimer);
    regulatedAuditState.searchTimer = window.setTimeout(() => {
      loadRegulatedAudit({ announce: false }).catch(() => undefined);
    }, 350);
  });
  window.addEventListener("cw:kcc20-regulated-deploy-complete", (event) => {
    const preferredAssetId = String(event?.detail?.asset_covenant_id || "").trim().toLowerCase();
    const submittedTxid = String(event?.detail?.submitted_txid || "").trim().toLowerCase();
    enrollDeployedRegulatedAssetAndPublish(preferredAssetId, submittedTxid).catch((errorValue) => {
      const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_deploy_auto_enrollment_failed";
      setText("crDeploySuccessMessage", `The zero-supply token is live. Governance publication is pending: ${reason}`);
    });
  });
  byId("crRegistryBuildBtn")?.addEventListener("click", deployPolicyRegistryOneClick);
  byId("crDemoPolicyCreateBtn")?.addEventListener("click", createDemoPolicy);
  byId("crDemoPolicyLoadBtn")?.addEventListener("click", () => loadDemoPolicy());
  byId("crDemoPolicySaveBtn")?.addEventListener("click", saveDemoPolicyDraft);
  byId("crDemoPolicyResetBtn")?.addEventListener("click", resetDemoPolicy);
  byId("crDemoPolicyExportBtn")?.addEventListener("click", exportDemoPolicy);
  byId("crControlApplyBtn")?.addEventListener("click", () => {
    applyControlOneClick().catch((errorValue) => {
      const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_control_apply_failed";
      renderControlProof({ ok: false, reason, token_units_moved: false });
      renderControlContext(`Control failed: ${reason}`);
    });
  });
  byId("crSeizeUnlockBtn")?.addEventListener("click", unlockDemoSeize);
  byId("crSeizeAsset")?.addEventListener("change", updateSeizeControls);
  ["crSeizeTargetHolderAddress", "crSeizeTargetHolderOutpoint", "crSeizeAmountRaw", "crSeizeDestinationAddress", "crSeizeOrderReference"].forEach((id) => {
    byId(id)?.addEventListener("input", updateSeizeControls);
  });
  byId("crSeizeExecuteBtn")?.addEventListener("click", () => {
    seizeRegulatedTokensOneClick().catch((errorValue) => {
      const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_seize_failed";
      const seizureUserResult = `FAILED — Seizure was not completed. ${reason}`;
      renderSeizeProof({ ok: false, user_result: seizureUserResult, reason, holder_signature_required: false });
      updateSeizeControls(seizureUserResult);
    });
  });
  byId("crForcedBurnUnlockBtn")?.addEventListener("click", unlockDemoForcedBurn);
  byId("crForcedBurnAsset")?.addEventListener("change", updateForcedBurnControls);
  ["crForcedBurnTargetHolderAddress", "crForcedBurnAmountRaw", "crForcedBurnOrderReference"].forEach((id) => {
    byId(id)?.addEventListener("input", updateForcedBurnControls);
  });
  byId("crForcedBurnExecuteBtn")?.addEventListener("click", () => {
    forceBurnRegulatedTokensOneClick().catch((errorValue) => {
      const reason = errorValue instanceof Error ? errorValue.message : "kcc20_regulated_forced_burn_failed";
      const forcedBurnUserResult = `FAILED — Forced burn was not completed. ${reason}`;
      renderForcedBurnProof({ ok: false, user_result: forcedBurnUserResult, reason, holder_signature_required: false });
      updateForcedBurnControls(forcedBurnUserResult);
    });
  });
  updateDemoPolicyButtons();
  renderControlContext();
  initializeIssueWorkspace();
});


const labState = {
  activeRulebookRoot: "",
  activeNetwork: "testnet-10",
  activeSnapshot: "",
  rulebook: null,
  canonicalJson: "",
  root: ""
};

function invalidateCalculatedLabDraft() {
  if (!labState.rulebook || !labState.canonicalJson || !labState.root) {
    updateDemoPolicyButtons();
    return;
  }

  labState.rulebook = null;
  labState.canonicalJson = "";
  labState.root = "";
  setText("crLabRoot", "—");
  setText("crLabCanonicalJson", "Draft changed. Recalculate to view canonical JSON.");
  setText("crLabRootComparison", "Draft changed — recalculate");
  setText("crLabCounts", "—");
  if (byId("crLabExport")) byId("crLabExport").disabled = true;
  updateDemoPolicyButtons();
}

function normalizeLineList(value, { lowercase = false } = {}) {
  const entries = String(value || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => lowercase ? entry.toLowerCase() : entry);
  return [...new Set(entries)].sort((a, b) => a.localeCompare(b));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function renderLabError(message) {
  const error = byId("crLabError");
  if (error) error.hidden = false;
  setText("crLabErrorText", message);
}

function clearLabError() {
  const error = byId("crLabError");
  if (error) error.hidden = true;
}

function parseLawfulActions() {
  const raw = String(byId("crLabLawfulActions")?.value || "[]").trim() || "[]";
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Lawful-order actions must be valid JSON.");
  }
  if (!Array.isArray(value)) throw new Error("Lawful-order actions must be a JSON array.");
  return value;
}

function validateRulebookDraft(rulebook) {
  if (rulebook.network !== "testnet-10") {
    throw new Error("Rulebook Lab is restricted to testnet-10.");
  }
  if (!Number.isInteger(rulebook.policy_epoch) || rulebook.policy_epoch < 1 || rulebook.policy_epoch > 4294967295) {
    throw new Error("Policy epoch must be an integer from 1 through 4294967295.");
  }
  if (!/^[0-9a-f]{64}$/.test(rulebook.source_policy_snapshot_id)) {
    throw new Error("Source policy snapshot ID must be exactly 64 lowercase hexadecimal characters.");
  }
  const invalidAsset = rulebook.regulated_asset_covenant_ids.find((value) => !/^[0-9a-f]{64}$/.test(value));
  if (invalidAsset) throw new Error(`Invalid regulated asset covenant ID: ${invalidAsset}`);
  const invalidOutpoint = rulebook.frozen_outpoints.find((value) => !/^[0-9a-fA-F]{64}:\d+$/.test(value));
  if (invalidOutpoint) throw new Error(`Invalid frozen outpoint: ${invalidOutpoint}`);
}

function collectRulebookDraftContent() {
  const network = String(byId("crLabNetwork")?.value || "").trim();
  if (network !== "testnet-10") throw new Error("Rulebook Lab is restricted to testnet-10.");
  const content = {
    regulated_asset_covenant_ids: normalizeLineList(byId("crLabRegulatedAssets")?.value, { lowercase: true }),
    recipient_allowlist: normalizeLineList(byId("crLabAllowlist")?.value, { lowercase: true }),
    recipient_blacklist: normalizeLineList(byId("crLabBlacklist")?.value, { lowercase: true }),
    frozen_holders: normalizeLineList(byId("crLabFrozenHolders")?.value, { lowercase: true }),
    frozen_outpoints: normalizeLineList(byId("crLabFrozenOutpoints")?.value, { lowercase: true }),
    lawful_order_actions: parseLawfulActions()
  };
  const invalidAsset = content.regulated_asset_covenant_ids.find((value) => !/^[0-9a-f]{64}$/.test(value));
  if (invalidAsset) throw new Error(`Invalid regulated asset covenant ID: ${invalidAsset}`);
  const invalidOutpoint = content.frozen_outpoints.find((value) => !/^[0-9a-f]{64}:\d+$/.test(value));
  if (invalidOutpoint) throw new Error(`Invalid frozen outpoint: ${invalidOutpoint}`);
  if (content.lawful_order_actions.length !== 0) {
    throw new Error("Lawful-order actions are not enabled yet and must remain an empty array.");
  }
  return content;
}

function renderLabCounts(rulebook) {
  const countText = [
    `${rulebook.regulated_asset_covenant_ids.length} assets`,
    `${rulebook.recipient_allowlist.length} allowed`,
    `${rulebook.recipient_blacklist.length} blocked`,
    `${rulebook.frozen_holders.length} frozen holders`,
    `${rulebook.frozen_outpoints.length} frozen outpoints`,
    `${rulebook.lawful_order_actions.length} lawful actions`
  ].join(" · ");
  setText("crLabCounts", countText);
}

async function calculateLabDraft() {
  clearLabError();
  try {
    const content = collectRulebookDraftContent();
    const sourcePolicySnapshotId = await sha256Hex(stableJson(content));
    const savedContent = demoPolicyState.policy ? demoPolicyContent(demoPolicyState.policy) : null;
    const contentChanged = !savedContent || stableJson(savedContent) !== stableJson(content);
    const currentEpoch = demoPolicyState.policy?.policy_epoch || 1;
    const policyEpoch = demoPolicyState.policy
      ? (contentChanged ? currentEpoch + 1 : currentEpoch)
      : 1;
    if (policyEpoch > 4294967295) throw new Error("Demo Policy epoch would exceed 4294967295.");
    const rulebook = {
      schema_kind: "kcc20_regulated_rulebook_v1",
      schema_version: 1,
      network: "testnet-10",
      policy_epoch: policyEpoch,
      source_policy_snapshot_id: sourcePolicySnapshotId,
      ...content
    };
    validateRulebookDraft(rulebook);
    if (byId("crLabSnapshot")) byId("crLabSnapshot").value = sourcePolicySnapshotId;
    const canonicalJson = stableJson(rulebook);
    const root = await sha256Hex(canonicalJson);
    labState.rulebook = rulebook;
    labState.canonicalJson = canonicalJson;
    labState.root = root;
    setText("crLabRoot", root);
    setText("crLabCanonicalJson", canonicalJson);
    renderLabCounts(rulebook);
    const currentRoot = labState.activeRulebookRoot;
    setText("crLabCurrentRoot", currentRoot || "Unavailable");
    setText("crLabRootComparison", currentRoot
      ? (root === currentRoot ? "Matches saved Demo Policy root" : "Differs from saved Demo Policy root")
      : "No saved Demo Policy root is loaded");
    if (byId("crLabExport")) byId("crLabExport").disabled = false;
    updateDemoPolicyButtons();
  } catch (errorValue) {
    labState.rulebook = null;
    labState.canonicalJson = "";
    labState.root = "";
    if (byId("crLabExport")) byId("crLabExport").disabled = true;
    renderLabError(errorValue instanceof Error ? errorValue.message : "Rulebook draft validation failed.");
    updateDemoPolicyButtons();
  }
}

function resetLabDraft() {
  clearLabError();
  if (demoPolicyState.policy && demoPolicyState.rulebook && demoPolicyState.rulebookRoot) {
    demoPolicyPopulateLab({
      policy: demoPolicyState.policy,
      rulebook: demoPolicyState.rulebook,
      sourceSnapshotId: demoPolicyState.sourceSnapshotId,
      rulebookRoot: demoPolicyState.rulebookRoot
    });
    return;
  }
  setText("crLabRoot", "—");
  setText("crLabCanonicalJson", "Calculate a valid draft to view canonical JSON.");
  setText("crLabRootComparison", "Not calculated");
  setText("crLabCounts", "—");
  [
    "crLabRegulatedAssets",
    "crLabAllowlist",
    "crLabBlacklist",
    "crLabFrozenHolders",
    "crLabFrozenOutpoints"
  ].forEach((id) => { if (byId(id)) byId(id).value = ""; });
  if (byId("crLabLawfulActions")) byId("crLabLawfulActions").value = "[]";
  if (byId("crLabNetwork")) byId("crLabNetwork").value = labState.activeNetwork || "testnet-10";
  if (byId("crLabSnapshot")) byId("crLabSnapshot").value = labState.activeSnapshot || "";
  if (byId("crLabExport")) byId("crLabExport").disabled = true;
  labState.rulebook = null;
  labState.canonicalJson = "";
  labState.root = "";
  updateDemoPolicyButtons();
}

function exportLabDraft() {
  if (!labState.rulebook || !labState.canonicalJson || !labState.root) return;
  const payload = {
    export_kind: "kcc20_regulated_rulebook_lab_export_v1",
    authoritative: false,
    testnet_only: true,
    rulebook: labState.rulebook,
    canonical_rulebook_json: labState.canonicalJson,
    canonical_rulebook_json_sha256: labState.root,
    rulebook_root: labState.root
  };
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `kcc20-regulated-rulebook-lab-${labState.root.slice(0, 12)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

document.addEventListener("DOMContentLoaded", () => {
  byId("crRulebookLabForm")?.addEventListener("input", invalidateCalculatedLabDraft);
  byId("crRulebookLabForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    calculateLabDraft();
  });
  byId("crLabReset")?.addEventListener("click", resetLabDraft);
  byId("crLabExport")?.addEventListener("click", exportLabDraft);
  resetLabDraft();
});
