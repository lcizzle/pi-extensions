export default function (pi) {
     pi.registerCommand("hello-world", {
       description: "Say Hello, World!",
       handler: async (_args, ctx) => {
         ctx.ui.notify("Hello, World!", "info");
       },
     });
   }