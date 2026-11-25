import { createQwenWorkProvider } from "./qwenwork.js";

// QwenWork CN — same device flow as the international deployment, pointed
// at gateway.qwenwork.cn with the CN desktop client's identity.
const qwenworkCn = createQwenWorkProvider("qwenwork-cn");

export default qwenworkCn;
