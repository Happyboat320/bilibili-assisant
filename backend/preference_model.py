"""冻结 MiniLM 的 token 嵌入上连接可训练 Transformer + MLP（始终使用 CPU）。"""
import torch
from torch import nn
from runtime import PreferencePaused

MAX_TOKENS = 48
EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


class PreferenceHead(nn.Module):
    def __init__(self, embedding_dim=384, hidden_dim=64):
        super().__init__()
        self.project = nn.Linear(embedding_dim, hidden_dim)
        self.cls = nn.Parameter(torch.zeros(1, 1, hidden_dim))
        self.position = nn.Parameter(torch.randn(1, MAX_TOKENS + 1, hidden_dim) * 0.02)
        layer = nn.TransformerEncoderLayer(hidden_dim, nhead=4, dim_feedforward=128,
                                           dropout=0.15, batch_first=True, norm_first=True)
        self.transformer = nn.TransformerEncoder(layer, num_layers=1, enable_nested_tensor=False)
        self.mlp = nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, 32), nn.GELU(),
                                 nn.Dropout(0.15), nn.Linear(32, 1))

    def forward(self, embeddings, mask):
        tokens = self.project(embeddings)
        cls = self.cls.expand(tokens.shape[0], -1, -1)
        tokens = torch.cat([cls, tokens], dim=1)
        tokens = tokens + self.position[:, :tokens.shape[1]]
        cls_mask = torch.ones((mask.shape[0], 1), dtype=torch.bool, device=mask.device)
        valid = torch.cat([cls_mask, mask.bool()], dim=1)
        output = self.transformer(tokens, src_key_padding_mask=~valid)
        # 返回 logits，训练使用数值稳定的 BCEWithLogitsLoss；推理再 sigmoid。
        return self.mlp(output[:, 0]).squeeze(-1)


def pack_features(features):
    """把不等长 token 序列补齐，只掩码 padding，不截断句子里的真实 token。"""
    length = max(len(item) for item in features)
    batch = torch.zeros((len(features), length, features[0].shape[-1]))
    mask = torch.zeros((len(features), length), dtype=torch.bool)
    for index, item in enumerate(features):
        batch[index, :len(item)] = item
        mask[index, :len(item)] = True
    return batch, mask


def fit_head(features, ratings, epochs=45, should_continue=None, seed=42):
    """训练小型偏好头；基础嵌入不反传，小样本下采用权重衰减和 dropout。"""
    torch.manual_seed(seed)
    head = PreferenceHead(features[0].shape[-1]).cpu()
    optimizer = torch.optim.AdamW(head.parameters(), lr=0.001, weight_decay=0.05)
    target = torch.tensor(ratings, dtype=torch.float32) / 3.0
    loss_fn = nn.BCEWithLogitsLoss()
    head.train()
    for _ in range(epochs):
        order = torch.randperm(len(features))
        for indices in order.split(32):
            if should_continue is not None and not should_continue():
                raise PreferencePaused("页面会话结束，训练已暂停。")
            embeddings, mask = pack_features([features[int(i)] for i in indices])
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(head(embeddings, mask), target[indices])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
            optimizer.step()
    head.eval()
    return head
