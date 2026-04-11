import "dotenv/config";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";

// ---------- Mock Data ----------

const PRODUCTS: Record<
  string,
  { name: string; sizes: string[]; price: number; inStock: boolean }
> = {
  "TS-001": {
    name: "Classic Cotton T-Shirt",
    sizes: ["XS", "S", "M", "L", "XL", "2XL"],
    price: 29.99,
    inStock: true,
  },
  "JN-042": {
    name: "Slim Fit Jeans",
    sizes: ["28", "30", "32", "34", "36"],
    price: 79.99,
    inStock: true,
  },
  "SW-103": {
    name: "Merino Wool Sweater",
    sizes: ["S", "M", "L", "XL"],
    price: 119.99,
    inStock: false,
  },
  "SH-017": {
    name: "Running Sneakers",
    sizes: ["7", "8", "9", "10", "11", "12"],
    price: 99.99,
    inStock: true,
  },
  "JK-205": {
    name: "Waterproof Rain Jacket",
    sizes: ["XS", "S", "M", "L", "XL"],
    price: 149.99,
    inStock: true,
  },
};

const ORDERS: Record<
  string,
  { status: string; estimatedDelivery: string; items: string[] }
> = {
  "ORD-12345": {
    status: "shipped",
    estimatedDelivery: "2025-01-20",
    items: ["Classic Cotton T-Shirt x2"],
  },
  "ORD-99881": {
    status: "processing",
    estimatedDelivery: "2025-01-22",
    items: ["Slim Fit Jeans x1"],
  },
  "ORD-55432": {
    status: "delivered",
    estimatedDelivery: "2025-01-10",
    items: ["Running Sneakers x1"],
  },
};

// ---------- Tools ----------

const productSearchTool = tool(
  async ({ query, size }) => {
    const hits = Object.entries(PRODUCTS).filter(([_, p]) =>
      p.name.toLowerCase().includes(query.toLowerCase())
    );

    if (hits.length === 0) return "No products found matching that query.";

    return hits
      .map(([id, p]) => {
        const sizeNote =
          size != null
            ? ` | Size ${size.toUpperCase()} available: ${p.sizes.includes(size.toUpperCase())}`
            : "";
        return (
          `${p.name} (${id}): $${p.price.toFixed(2)}` +
          ` | Sizes: ${p.sizes.join(", ")}` +
          ` | In Stock: ${p.inStock}` +
          sizeNote
        );
      })
      .join("\n");
  },
  {
    name: "product_search",
    description:
      "Search the StyleShop product catalog. Use this to answer questions about availability, pricing, and sizing.",
    schema: z.object({
      query: z.string().describe("Product name or type to search for"),
      size: z
        .string()
        .optional()
        .describe("Specific size to check availability for"),
    }),
  }
);

const orderLookupTool = tool(
  async ({ orderId }) => {
    const order = ORDERS[orderId.toUpperCase()];
    if (!order)
      return `Order ${orderId} not found. Please ask the customer to verify the order number.`;
    return (
      `Order ${orderId}: Status: ${order.status}` +
      ` | Estimated delivery: ${order.estimatedDelivery}` +
      ` | Items: ${order.items.join(", ")}`
    );
  },
  {
    name: "order_lookup",
    description: "Look up a customer's order status and details by order ID.",
    schema: z.object({
      orderId: z
        .string()
        .describe("The order ID to look up (e.g. ORD-12345)"),
    }),
  }
);

// ---------- System Prompt ----------

const SYSTEM_PROMPT =
  "You are a customer support agent for StyleShop, an online clothing retailer. " +
  "You help customers with:\n" +
  "- Product availability, sizing, and pricing\n" +
  "- Order status and tracking\n" +
  "- Return and exchange policies\n" +
  "- Shipping information\n" +
  "- Accepted payment methods\n\n" +
  "Store policies:\n" +
  "- Returns: 30-day window for unworn items with tags attached. Sale items are final sale.\n" +
  "- Exchanges: Free size exchanges within 30 days.\n" +
  "- Shipping: Free standard shipping on orders over $75. Express shipping is $12.99. " +
  "We ship to 25 countries internationally.\n" +
  "- Payment: Visa, Mastercard, American Express, PayPal, and Apple Pay.\n\n" +
  "Always use the available tools before answering questions about products or orders. " +
  "Politely decline any request unrelated to StyleShop's products and services. " +
  "Do not answer general knowledge questions, give personal advice, or discuss topics " +
  "outside of this store's scope.";

// ---------- Agent Factory ----------

export function createSupportAgent(modelName: string) {
  const model = new ChatOpenAI({
    model: modelName,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
    },
  });

  return createAgent({
    model,
    tools: [productSearchTool, orderLookupTool],
    systemPrompt: SYSTEM_PROMPT,
  });
}
