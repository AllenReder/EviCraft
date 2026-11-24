import { ManualOperatorInteraction } from "../../dist/harness/manual-operator-interaction.js";

const interaction = new ManualOperatorInteraction();
const selection = await interaction.choose({
  observation: "SELF position=(0,64,0)",
  tools: [{
    name: "face",
    description: "Choose a direction",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["direction"],
      properties: { direction: { type: "string", enum: ["north", "south"] } },
    },
  }],
}, {});
interaction.close();
process.stdout.write(`RESULT ${JSON.stringify(selection)}\n`);
