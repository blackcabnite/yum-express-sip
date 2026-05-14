// Tool schemas — the contract with the OpenAI Realtime model.
//
// Names and shapes here must match what CallSession.onToolCall switches on.

export const TOOLS: readonly unknown[] = [
  {
    type: "function",
    name: "record_items",
    description:
      "Record one or more menu items the caller named. Pass ALL items from the caller's last sentence in one call. Include the size field only if the caller stated one — otherwise omit it and Regular is assumed. Returns 'spoken' to be read verbatim.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "All items mentioned in the caller's last turn.",
          items: {
            type: "object",
            properties: {
              item: { type: "string", description: "Menu item name." },
              size: { type: "string", enum: ["Small", "Regular", "Large"] },
              quantity: { type: "integer", minimum: 1, default: 1 },
              notes: {
                type: "string",
                description: "Optional caller requests (e.g. 'oat milk', 'extra shot').",
              },
            },
            required: ["item"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    type: "function",
    name: "change_size",
    description:
      "Change the size of a sized item already on the order. Pass the item base name and target size. Optional qty splits a multi-unit line. Returns 'spoken' verbatim.",
    parameters: {
      type: "object",
      properties: {
        item: { type: "string", description: "Item base name. Empty string = most recent sized line." },
        size: { type: "string", enum: ["Small", "Regular", "Large"] },
        qty: { type: "integer", minimum: 1 },
      },
      required: ["size"],
    },
  },
  {
    type: "function",
    name: "remove_items",
    description:
      "Remove items from the order. Pass an array; each entry has item name and optionally qty (omit qty to remove the whole line). Returns 'spoken' verbatim.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string" },
              qty: { type: "integer", minimum: 1 },
            },
            required: ["item"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    type: "function",
    name: "confirm_order",
    description:
      "Finalize the order when the caller is done. Returns 'spoken' with the full closing line — read verbatim and stop.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "set_name",
    description: "Record the caller's name. Only call if they offer one.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];
