import * as React from "react";
import "./ErrorMessage.css";

interface ErrorMessageProps {
    title: string;
    message: string;
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ title, message }) => {
    return (
        <div className="error-message">
            <h4 className="error-title">{title}</h4>
            <p className="error-body">{message}</p>
        </div>
    );
};
