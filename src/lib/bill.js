import { clamp, toPositiveInt, toRate } from './format';

function itemLineTotal(item) {
  const price = Number.parseInt(item.price, 10);
  const quantity = Math.max(1, toPositiveInt(item.quantity, 1));

  return (Number.isFinite(price) ? price : 0) * quantity;
}

export function isDiscountItem(item) {
  const name = String(item?.name || '').toLowerCase();
  return itemLineTotal(item) < 0 || name.includes('discount') || name.includes('diskon') || name.includes('potongan');
}

function sanitizeItem(item, index = 0) {
  const rawPrice = Number.parseInt(item.price, 10);
  const rawQuantity = Math.max(1, toPositiveInt(item.quantity, 1));
  const signedPrice = Number.isFinite(rawPrice) ? rawPrice : 0;

  return {
    ...item,
    id: item.id || `item-${index + 1}`,
    name: item.name?.trim() || `Item ${index + 1}`,
    price: isDiscountItem(item) ? Math.min(0, signedPrice) : Math.max(0, signedPrice),
    quantity: rawQuantity,
  };
}

export function normalizeReceipt(receipt) {
  const items = (receipt.items || []).map(sanitizeItem);
  const computedSubtotal = items.reduce((sum, item) => sum + itemLineTotal(item), 0);
  const subtotal = toPositiveInt(receipt.subtotal, computedSubtotal) || computedSubtotal;
  const taxRate = toRate(receipt.taxRate ?? 0, 0, 0.5, 0);
  const serviceRate = toRate(receipt.serviceRate ?? 0, 0, 0.3, 0);
  const tax = receipt.tax != null ? toPositiveInt(receipt.tax) : Math.round(subtotal * taxRate);
  const serviceCharge =
    receipt.serviceCharge != null
      ? toPositiveInt(receipt.serviceCharge)
      : Math.round(subtotal * serviceRate);
  const grandTotal =
    receipt.grandTotal != null
      ? toPositiveInt(receipt.grandTotal)
      : subtotal + tax + serviceCharge;

  return {
    rawImage: receipt.rawImage || null,
    restaurantName: receipt.restaurantName?.trim() || '',
    items,
    subtotal,
    tax,
    taxRate,
    serviceCharge,
    serviceRate,
    grandTotal,
  };
}

export function createEmptyAssignments(items, previous = {}) {
  return items.reduce((accumulator, item) => {
    accumulator[item.id] = Array.isArray(previous[item.id]) ? previous[item.id] : [];
    return accumulator;
  }, {});
}

export function getItemLabel(item) {
  const total = itemLineTotal(item);
  return `${item.name} • ${item.quantity}x • ${total}`;
}

export function allocateRounded(rawValues, target) {
  const rounded = rawValues.map((value) => Math.trunc(value));
  let delta = target - rounded.reduce((sum, value) => sum + value, 0);
  let index = 0;

  while (delta !== 0 && rounded.length > 0) {
    const pointer = index % rounded.length;
    if (delta > 0) {
      rounded[pointer] += 1;
      delta -= 1;
    } else {
      rounded[pointer] -= 1;
      delta += 1;
    }
    index += 1;
  }

  return rounded;
}

export function calculateSummary({ receipt, participants, assignments }) {
  const normalizedReceipt = normalizeReceipt(receipt);
  const validParticipants = participants.filter((participant) => participant?.id && participant?.name);
  const people = validParticipants.map((participant) => ({
    ...participant,
    lineItems: [],
    subtotal: 0,
    tax: 0,
    service: 0,
    total: 0,
  }));
  const personIndex = new Map(people.map((person, index) => [person.id, index]));
  const unassignedItemIds = [];
  const discountItems = [];

  normalizedReceipt.items.forEach((item) => {
    if (isDiscountItem(item)) {
      discountItems.push(item);
      return;
    }

    const assignees = (assignments[item.id] || []).filter((participantId) =>
      personIndex.has(participantId),
    );

    if (!assignees.length) {
      unassignedItemIds.push(item.id);
      return;
    }

    const total = itemLineTotal(item);
    const splitValues = allocateRounded(
      assignees.map(() => total / assignees.length),
      total,
    );

    assignees.forEach((participantId, index) => {
      const person = people[personIndex.get(participantId)];
      const share = splitValues[index];

      person.lineItems.push({
        itemId: item.id,
        name: item.name,
        quantity: item.quantity,
        share,
        total,
        splitCount: assignees.length,
      });
      person.subtotal += share;
    });
  });

  const positiveSubtotalBase = people.reduce((sum, person) => sum + Math.max(0, person.subtotal), 0);

  discountItems.forEach((item) => {
    const total = itemLineTotal(item);
    const hasPositiveBase = positiveSubtotalBase > 0;
    const baseValues = people.map((person) => (hasPositiveBase ? Math.max(0, person.subtotal) : 1));
    const basePool = hasPositiveBase ? positiveSubtotalBase : people.length || 1;
    const splitValues = allocateRounded(
      baseValues.map((value) => (total * value) / basePool),
      total,
    );

    splitValues.forEach((share, index) => {
      const person = people[index];

      if (!person) {
        return;
      }

      person.lineItems.push({
        itemId: item.id,
        name: item.name,
        quantity: item.quantity,
        share,
        total,
        splitCount: people.length,
        autoSplit: true,
      });
      person.subtotal += share;
    });
  });

  const subtotalBase = people.reduce((sum, person) => sum + person.subtotal, 0) || normalizedReceipt.subtotal || 0;
  const taxTarget = normalizedReceipt.tax;
  const serviceTarget = normalizedReceipt.serviceCharge;
  const taxableBase = people.reduce((sum, person) => sum + Math.max(0, person.subtotal), 0);

  const taxAllocations = allocateRounded(
    people.map((person) =>
      taxableBase > 0 ? (Math.max(0, person.subtotal) / taxableBase) * taxTarget : 0,
    ),
    taxTarget,
  );
  const serviceAllocations = allocateRounded(
    people.map((person) =>
      taxableBase > 0 ? (Math.max(0, person.subtotal) / taxableBase) * serviceTarget : 0,
    ),
    serviceTarget,
  );

  people.forEach((person, index) => {
    person.tax = taxAllocations[index] || 0;
    person.service = serviceAllocations[index] || 0;
    person.total = person.subtotal + person.tax + person.service;
  });

  const computedGrandTotal = people.reduce((sum, person) => sum + person.total, 0);
  const grandTotalTarget = normalizedReceipt.grandTotal || computedGrandTotal;
  const grandTotalMismatch = grandTotalTarget - computedGrandTotal;

  if (grandTotalMismatch !== 0 && people[0]) {
    people[0].total += grandTotalMismatch;
    people[0].service += grandTotalMismatch;
  }

  return {
    receipt: normalizedReceipt,
    people,
    progress: normalizedReceipt.items.filter((item) => !isDiscountItem(item)).length
      ? (normalizedReceipt.items.filter((item) => !isDiscountItem(item)).length - unassignedItemIds.length) /
        normalizedReceipt.items.filter((item) => !isDiscountItem(item)).length
      : 0,
    unassignedItemIds,
    totals: {
      subtotal: subtotalBase,
      tax: taxTarget,
      service: serviceTarget,
      grandTotal: grandTotalTarget,
      computedGrandTotal: grandTotalTarget,
    },
    hasUnassignedItems: unassignedItemIds.length > 0,
    shareMap: normalizedReceipt.items.reduce((accumulator, item) => {
      accumulator[item.id] = clamp((assignments[item.id] || []).length, 0, participants.length);
      return accumulator;
    }, {}),
  };
}

export function buildShareText(summary) {
  const lines = [
    `🍽️ Split Bill - ${summary.receipt.restaurantName || 'Tanpa Nama Restoran'}`,
    `📅 ${new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date())}`,
    '─────────────────',
  ];

  summary.people.forEach((person) => {
    lines.push(`👤 ${person.name}: Rp ${person.total.toLocaleString('id-ID')}`);
    person.lineItems.forEach((lineItem) => {
      const splitLabel = lineItem.splitCount > 1 ? ` (split ${lineItem.splitCount})` : '';
      lines.push(`   • ${lineItem.name}${splitLabel}: Rp ${lineItem.share.toLocaleString('id-ID')}`);
    });

    const overhead = person.tax + person.service;
    if (overhead > 0) {
      lines.push(`   • Tax + Service: Rp ${overhead.toLocaleString('id-ID')}`);
    }
    lines.push('');
  });

  lines.push('─────────────────');
  lines.push(`Total: Rp ${summary.totals.grandTotal.toLocaleString('id-ID')}`);
  lines.push('Generated by Split Bill App');

  return lines.join('\n');
}
