(() => {
  function requireDeps(deps) {
    const d = deps && typeof deps === 'object' ? deps : null;
    if (!d) throw new Error('send_engine_missing_deps');

    const need = [
      'jpost',
      'kaspaReadyOrThrow'
    ];

    for (const key of need) {
      if (typeof d[key] !== 'function') {
        throw new Error(`send_engine_missing_dep:${key}`);
      }
    }

    return d;
  }

  function humanToRawAmount(amountStr, dec) {
    const s = String(amountStr || '').trim();
    const d = Number(dec);
    if (!s) return null;
    if (!Number.isFinite(d) || d < 0 || d > 18) return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;

    const parts = s.split('.');
    const whole = parts[0] || '0';
    const frac = parts[1] || '';

    if (d === 0) {
      if (frac && !/^0+$/.test(frac)) return null;
      const v0 = BigInt(whole);
      return v0 > 0n ? v0.toString() : null;
    }

    if (frac.length > d) return null;

    const fracPadded = (frac + '0'.repeat(d)).slice(0, d);
    const scale = 10n ** BigInt(d);
    const v = BigInt(whole) * scale + BigInt(fracPadded || '0');
    return v > 0n ? v.toString() : null;
  }

  function withExecutionGuard(payload, args) {
    const next = payload && typeof payload === 'object' ? { ...payload } : {};

    const purchaseId = String(args && args.purchaseId ? args.purchaseId : '').trim();
    if (purchaseId) next.purchaseId = purchaseId;

    const fulfillmentBatchId = String(args && args.fulfillmentBatchId ? args.fulfillmentBatchId : '').trim();
    if (fulfillmentBatchId) next.fulfillmentBatchId = fulfillmentBatchId;

    const fulfillmentExecutionNonce = String(
      args && args.fulfillmentExecutionNonce ? args.fulfillmentExecutionNonce : ''
    ).trim();
    if (fulfillmentExecutionNonce) next.fulfillmentExecutionNonce = fulfillmentExecutionNonce;

    return next;
  }

  function krc20EntryAmountSompi(entry) {
    try {
      return BigInt(String(entry && entry.amount !== undefined ? entry.amount : '0'));
    } catch (_err) {
      return 0n;
    }
  }

  function krc20EntryKey(entry) {
    const op = entry && entry.outpoint ? entry.outpoint : null;
    return String(op && op.transactionId ? op.transactionId : '') + ':' + String(op && op.index !== undefined ? op.index : '');
  }

  function buildKrc20CommitEntryCandidates(entries, minRequiredSompi) {
    const usable = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.outpoint && krc20EntryAmountSompi(entry) > 0n);

    const sortedAsc = usable.slice().sort((a, b) => {
      const aa = krc20EntryAmountSompi(a);
      const bb = krc20EntryAmountSompi(b);
      if (aa === bb) return 0;
      return aa < bb ? -1 : 1;
    });
    const sortedDesc = sortedAsc.slice().reverse();
    const candidateSets = [];
    const seen = new Set();

    const pushCandidateSet = (items) => {
      const candidate = (Array.isArray(items) ? items : []).filter(Boolean);
      if (!candidate.length) return;

      const key = candidate.map(krc20EntryKey).join('|');
      if (seen.has(key)) return;

      seen.add(key);
      candidateSets.push(candidate);
    };

    for (const entry of sortedAsc) {
      if (krc20EntryAmountSompi(entry) >= minRequiredSompi) {
        pushCandidateSet([entry]);
      }
    }

    let descendingTotal = 0n;
    const descendingSet = [];
    for (const entry of sortedDesc) {
      descendingSet.push(entry);
      descendingTotal += krc20EntryAmountSompi(entry);
      if (descendingTotal >= minRequiredSompi) {
        pushCandidateSet(descendingSet);
      }
    }

    let ascendingTotal = 0n;
    const ascendingSet = [];
    for (const entry of sortedAsc) {
      ascendingSet.push(entry);
      ascendingTotal += krc20EntryAmountSompi(entry);
      if (ascendingTotal >= minRequiredSompi) {
        pushCandidateSet(ascendingSet);
      }
    }

    pushCandidateSet(sortedDesc);

    return candidateSets;
  }

  async function sendKrc20CommitRevealTransferSW(args, deps) {
    const {
      token,
      to,
      amountRaw,
      keyring
    } = args && typeof args === 'object' ? args : {};

    const {
      jpost,
      kaspaReadyOrThrow
    } = requireDeps(deps);

    const build = await jpost(
      '/api/wallet/send',
      withExecutionGuard({ token, to, amount: amountRaw, stage: 'krc_commit_build' }, args)
    );
    if (build && build.ok === true && build.stage === 'bcw_krc20_intent') {
      const k = await kaspaReadyOrThrow();
      if (!keyring || !keyring.priv0) throw new Error('wallet_locked');
      if (typeof k.signMessage !== 'function') throw new Error('signMessage_unavailable');

      const intent = build.intent && typeof build.intent === 'object' ? build.intent : null;
      const intentMessage = String(build.intent_message || '').trim();
      if (!intent || !intentMessage) throw new Error('bcw_krc20_intent_invalid');

      const authSignature = k.signMessage({
        message: intentMessage,
        privateKey: keyring.priv0
      });

      const submitPayload = withExecutionGuard({
        token,
        to,
        amount: amountRaw,
        stage: 'krc_commit_submit',
        bcw_krc20_intent: intent,
        bcw_auth_signature: String(authSignature || '')
      }, args);

      return await jpost('/api/wallet/send', submitPayload);
    }

    if (!build || build.ok !== true || build.stage !== 'krc_commit_build') {
      const msg = (build && (build.error || build.message)) || 'KRC commit build failed';
      throw new Error(msg);
    }

    const k = await kaspaReadyOrThrow();

    const networkId = String(build.networkId || '');
    const fromAddress = String(build.fromAddress || '');
    const feeRate = Number(build.feeRate || 0);
    const commitAmountSompi = BigInt(String(build.commitAmountSompi || '0'));
    const payloadJson = String(build.payloadJson || '');

    if (!networkId || !fromAddress || !payloadJson || commitAmountSompi <= 0n) {
      throw new Error('krc_commit_build_invalid');
    }

    const entriesSafe = Array.isArray(build.entries) ? build.entries : [];
    const entries = entriesSafe.map((e) => ({
      outpoint: e.outpoint,
      scriptPublicKey: e.scriptPublicKey,
      isCoinbase: !!e.isCoinbase,
      amount: BigInt(String(e.amount || '0')),
      blockDaaScore: BigInt(String(e.blockDaaScore || '0')),
    }));

    const enc = new TextEncoder();

    const pub = keyring.priv0.toPublicKey();
    const script = new k.ScriptBuilder()
      .addData(pub.toXOnlyPublicKey().toString())
      .addOp(k.Opcodes.OpCheckSig)
      .addOp(k.Opcodes.OpFalse)
      .addOp(k.Opcodes.OpIf)
      .addData(enc.encode('kasplex'))
      .addI64(0n)
      .addData(enc.encode(payloadJson))
      .addOp(k.Opcodes.OpEndIf);

    const p2shAddrObj = k.addressFromScriptPublicKey(script.createPayToScriptHashScript(), networkId);
    const p2shAddress = p2shAddrObj ? p2shAddrObj.toString() : '';
    if (!p2shAddress) throw new Error('p2sh_address_failed');

    const outputs = [{ address: p2shAddress, amount: commitAmountSompi }];

    const commitEntryCandidates = buildKrc20CommitEntryCandidates(entries, commitAmountSompi);
    let commitCreated = null;
    let commitCreateLastError = null;

    for (const candidateEntries of commitEntryCandidates) {
      try {
        commitCreated = await k.createTransactions({
          outputs,
          changeAddress: fromAddress,
          feeRate,
          priorityFee: { amount: 0n, source: k.FeeSource.SenderPays },
          entries: candidateEntries,
          networkId
        });

        if (!commitCreated || !commitCreated.transactions || !commitCreated.transactions.length) {
          throw new Error('krc_commit_create_empty_batch');
        }

        break;
      } catch (err) {
        commitCreated = null;
        commitCreateLastError = err;
      }
    }

    if (!commitCreated) {
      const msg = commitCreateLastError && commitCreateLastError.message
        ? commitCreateLastError.message
        : String(commitCreateLastError || 'KRC commit transaction create failed');
      throw new Error('krc_commit_create_failed: ' + msg);
    }

    const signed_commit = [];
    for (const ptx of commitCreated.transactions) {
      ptx.sign([keyring.priv0], true);
      signed_commit.push(ptx.serializeToSafeJSON());
    }

    const commitSubmitPayload = withExecutionGuard(
      { token, to, amount: amountRaw, stage: 'krc_commit_submit', signed_txs: signed_commit },
      args
    );
    const commitRes = await jpost('/api/wallet/send', commitSubmitPayload);
    if (!commitRes || commitRes.ok !== true) {
      const msg = (commitRes && (commitRes.error || commitRes.message)) || 'Commit submit failed';
      throw new Error(msg);
    }

    const commitTxids = Array.isArray(commitRes.commitTxids)
      ? commitRes.commitTxids
      : (Array.isArray(commitRes.txids) ? commitRes.txids : []);

    if (!commitTxids || commitTxids.length === 0) {
      throw new Error('commit_txids_missing');
    }

    const waitRes = await jpost(
      '/api/wallet/send',
      withExecutionGuard({ token, to, amount: amountRaw, stage: 'krc_reveal_wait', p2shAddress, commitTxids }, args)
    );
    if (!waitRes || waitRes.ok !== true || waitRes.stage !== 'krc_reveal_wait') {
      const msg = (waitRes && (waitRes.error || waitRes.message)) || 'Reveal wait failed';
      throw new Error(msg);
    }

    const ce = waitRes.commitEntry || null;
    if (!ce || !ce.outpoint) throw new Error('commit_entry_missing');

    const commitEntry = {
      outpoint: ce.outpoint,
      scriptPublicKey: ce.scriptPublicKey,
      isCoinbase: !!ce.isCoinbase,
      amount: BigInt(String(ce.amount || '0')),
      blockDaaScore: BigInt(String(ce.blockDaaScore || '0')),
    };

    const wantedTxid = String(ce?.outpoint?.transactionId || '');
    const wantedIdx = Number(ce?.outpoint?.index ?? -1);

    const buildReveal = async (effectiveFeeRate) => {
      const args0 = {
        priorityEntries: [commitEntry],
        entries: [],
        changeAddress: fromAddress,
        outputs: [],
        feeRate: effectiveFeeRate,
        priorityFee: 0n,
        networkId
      };

      const created = await k.createTransactions(args0);
      if (!created.transactions || created.transactions.length !== 1) {
        throw new Error('unexpected_reveal_batch');
      }
      return created.transactions[0];
    };

    const fillRevealInput0OrThrow = async (tx) => {
      const inputIndex = tx.transaction.inputs.findIndex((input) => {
        const op = input && input.previousOutpoint ? input.previousOutpoint : null;
        const tid = op && typeof op.transactionId === 'string' ? op.transactionId : '';
        const idx = op && typeof op.index === 'number' ? op.index : -1;
        return tid === wantedTxid && idx === wantedIdx;
      });

      if (inputIndex === -1) throw new Error('p2sh_input_not_found');
      if (inputIndex !== 0) throw new Error('p2sh_input_not_input0');

      const signature = await tx.createInputSignature(0, keyring.priv0);
      tx.fillInput(0, script.encodePayToScriptHashSignatureScript(signature));

      const massOk = k.updateTransactionMass(networkId, tx.transaction);
      if (!massOk) throw new Error('reveal_tx_mass_exceeds_standard');
    };

    const KRC20_TOCCATA_FEE_RATE_FLOOR = 100n;

    const parseMassOrThrow = (value) => {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return BigInt(Math.ceil(value));
      if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
      throw new Error('reveal_tx_mass_exceeds_standard');
    };

    const signatureScriptBytes = (input) => {
      const scriptHex = input && typeof input.signatureScript === 'string' ? input.signatureScript : '';
      if (!scriptHex) return 0n;
      if (scriptHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(scriptHex)) {
        throw new Error('reveal_tx_signature_script_invalid');
      }
      return BigInt(scriptHex.length / 2);
    };

    const toccataRequiredRevealFee = (tx) => {
      const baseMass = parseMassOrThrow(tx.transaction && tx.transaction.mass);
      const inputs = tx.transaction && Array.isArray(tx.transaction.inputs) ? tx.transaction.inputs : [];
      const signedScriptBytes = inputs.reduce((sum, input) => sum + signatureScriptBytes(input), 0n);
      return (baseMass + signedScriptBytes) * KRC20_TOCCATA_FEE_RATE_FLOOR;
    };

    const tx0 = await buildReveal(feeRate);
    await fillRevealInput0OrThrow(tx0);

    const requiredFee0 = toccataRequiredRevealFee(tx0);

    let revealTx = tx0;

    if (revealTx.feeAmount < requiredFee0) {
      const currentFee = revealTx.feeAmount > 0n ? revealTx.feeAmount : 1n;
      const scale = 1000000n;
      const scaled = (requiredFee0 * scale + currentFee - 1n) / currentFee;
      const neededFeeRate = Math.max(1.0, feeRate * (Number(scaled) / 1000000));
      const effectiveFeeRate = Math.max(feeRate, neededFeeRate);

      const tx1 = await buildReveal(effectiveFeeRate);
      await fillRevealInput0OrThrow(tx1);

      const requiredFee1 = toccataRequiredRevealFee(tx1);
      if (tx1.feeAmount < requiredFee1) throw new Error('reveal_fee_under_minimum');

      revealTx = tx1;
    }

    const signed_reveal = [revealTx.serializeToSafeJSON()];

    const revealSubmitPayload = withExecutionGuard(
      { token, to, amount: amountRaw, stage: 'krc_reveal_submit', signed_txs: signed_reveal },
      args
    );
    const revealRes = await jpost('/api/wallet/send', revealSubmitPayload);
    if (!revealRes || revealRes.ok !== true) {
      const msg = (revealRes && (revealRes.error || revealRes.message)) || 'Reveal submit failed';
      throw new Error(msg);
    }

    return revealRes;
  }

  async function sendSingleTransfer(args, deps) {
    const {
      token,
      to,
      amountRaw,
      keyring,
      useMax,
      purchaseId,
      fulfillmentBatchId,
      fulfillmentExecutionNonce
    } = args && typeof args === 'object' ? args : {};

    const {
      jpost,
      kaspaReadyOrThrow
    } = requireDeps(deps);

    if (token !== 'KAS') {
      return await sendKrc20CommitRevealTransferSW(
        { token, to, amountRaw, keyring, purchaseId, fulfillmentBatchId, fulfillmentExecutionNonce },
        deps
      );
    }

    const buildPayload = withExecutionGuard({ token, to, amount: amountRaw, stage: 'build' }, args);
    if (useMax === true) buildPayload.use_max = true;

    const build = await jpost('/api/wallet/send', buildPayload);
    if (build && build.ok === true && build.stage === 'bcw_intent') {
      const k = await kaspaReadyOrThrow();
      if (!keyring || !keyring.priv0) throw new Error('wallet_locked');
      if (typeof k.signMessage !== 'function') throw new Error('signMessage_unavailable');

      const intent = build.intent && typeof build.intent === 'object' ? build.intent : null;
      const intentMessage = String(build.intent_message || '').trim();
      if (!intent || !intentMessage) throw new Error('bcw_intent_invalid');

      const authSignature = k.signMessage({
        message: intentMessage,
        privateKey: keyring.priv0
      });

      const submitPayload = withExecutionGuard({
        token,
        to,
        amount: amountRaw,
        stage: 'submit',
        bcw_intent: intent,
        bcw_auth_signature: String(authSignature || '')
      }, args);
      if (useMax === true) submitPayload.use_max = true;

      return await jpost('/api/wallet/send', submitPayload);
    }

    if (!build || build.ok !== true || build.stage !== 'build') {
      const msg = (build && (build.error || build.message || build.reason)) || 'Build failed';
      throw new Error(msg);
    }

    const k = await kaspaReadyOrThrow();
    const entriesSafe = Array.isArray(build.entries) ? build.entries : [];
    const entries = entriesSafe.map((e) => ({
      outpoint: e.outpoint,
      scriptPublicKey: e.scriptPublicKey,
      isCoinbase: !!e.isCoinbase,
      amount: BigInt(String(e.amount || '0')),
      blockDaaScore: BigInt(String(e.blockDaaScore || '0')),
    }));

    const priorityFee = useMax === true ? { amount: 0n, source: k.FeeSource.ReceiverPays } : 0n;
    const outputs = [{ address: to, amount: BigInt(String(build.amountSompi || '0')) }];

    const txOpts = {
      outputs,
      changeAddress: String(build.changeAddress || ''),
      feeRate: Number(build.feeRate || 0),
      priorityFee,
      entries,
      networkId: String(build.networkId || '')
    };

    const created = await k.createTransactions(txOpts);

    const signed_txs = [];
    for (const ptx of created.transactions) {
      ptx.sign([keyring.priv0], true);
      signed_txs.push(ptx.serializeToSafeJSON());
    }

    const submitPayload = withExecutionGuard({ token, to, amount: amountRaw, stage: 'submit', signed_txs }, args);
    return await jpost('/api/wallet/send', submitPayload);
  }

  window.CWSendEngine = {
    humanToRawAmount,
    sendKrc20CommitRevealTransferSW,
    sendSingleTransfer
  };
})();
