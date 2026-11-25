"use client";

import PropTypes from "prop-types";

/**
 * Native HTML5 drag wrapper for provider cards. Shared by the dashboard
 * providers page and the media-providers listing pages so every surface drags
 * identically. The parent owns the state (dragging id / over id) and the
 * reorder + persist logic (shared/utils/providerCardOrder.js).
 */
export default function DraggableCard({
  cardId,
  isDragging,
  isOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  children,
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        // 卡内含 <Link>（anchor）时浏览器会把链接 URL 填进 dataTransfer 并在
        // 松手时导航 —— 覆写数据、抬起 effectAllowed，并抑制 Link 的默认
        // 拖放语义，否则卡片拖拽在 anchor 子元素上变成链接拖动（媒体页
        // System One 列表实测：拖前两张卡不交换位置）。
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", cardId);
        } catch {}
        onDragStart?.(cardId);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        onDragOver?.(cardId);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDrop?.(cardId);
      }}
      onDragEnd={(e) => {
        // anchor 拖放未命中目标时浏览器会导航 —— 一律阻止 dragend 的默认行为
        e.preventDefault?.();
        onDragEnd?.(e);
      }}
      className={`min-w-0 transition-all rounded-xl cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-30 scale-[0.98]" : isOver ? "ring-2 ring-primary/60 scale-[1.01]" : ""
      }`}
    >
      {children}
    </div>
  );
}

DraggableCard.propTypes = {
  cardId: PropTypes.string.isRequired,
  isDragging: PropTypes.bool,
  isOver: PropTypes.bool,
  onDragStart: PropTypes.func,
  onDragOver: PropTypes.func,
  onDrop: PropTypes.func,
  onDragEnd: PropTypes.func,
  children: PropTypes.node,
};
